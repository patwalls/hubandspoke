import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  contentComments,
  formats,
  productionItems,
  repurposeTriggers,
  transcripts,
  users,
} from "@/lib/db/schema";
import {
  duplicateDescriptComposition,
  invokeDescriptAgent,
  substituteFormatPrompt,
} from "@/lib/descript";
import { resolveDescriptAccountForActor } from "@/lib/services/descript-account";
import { buildCompositionName } from "@/lib/services/descript-composition";
import { coldImportPillar } from "@/lib/services/descript-derivative";
import { enqueue } from "@/jobs/enqueue";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { recordItemCreated } from "@/lib/services/item-created";
import { recordToolAction } from "@/lib/services/content-events";
import { extractDescriptSection } from "@/lib/format-skill";
import { resolveClipAspectRatio } from "@/lib/db/formats";

/**
 * Pull the optional `quotables` array out of a clip_idea's extras payload.
 * Used by the Descript prompt builder to substitute `{{quotables}}` for X
 * Quotables-style formats. Defensive: returns an empty array for any
 * shape that isn't `string[]` (legacy rows pre-extras, or future formats
 * whose extras schema doesn't include quotables).
 */
export function extractQuotablesFromExtras(
  extras: Record<string, unknown> | null,
): string[] {
  if (!extras) return [];
  const q = extras.quotables;
  if (!Array.isArray(q)) return [];
  return q.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/**
 * Check if a caught database error is a unique constraint violation for a
 * specific constraint name. Used to distinguish double-promote attempts from
 * other errors and return the appropriate HTTP status code.
 */
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  // Check for postgres unique constraint error pattern: "duplicate key value"
  // or "Unique constraint" in the message
  return (
    (msg.includes("duplicate key") || msg.includes("UNIQUE constraint")) &&
    msg.includes(constraintName)
  );
}

export async function killClipIdea(args: {
  clipIdeaId: string;
  killReason: string | null;
  decidedByUserId: string;
}): Promise<void> {
  await db
    .update(clipIdeas)
    .set({
      status: "killed",
      killReason: args.killReason,
      decidedAt: new Date(),
      decidedByUserId: args.decidedByUserId,
    })
    .where(eq(clipIdeas.id, args.clipIdeaId));

  // Mirror onto the queue-side production_item so the killed clip drops out
  // of /[brand]/queue. Generation creates the prod_item up-front; only legacy
  // pre-backfill rows would lack one — those are rare and harmless to leave.
  await db
    .update(productionItems)
    .set({
      status: "Killed",
      updatedAt: new Date(),
    })
    .where(eq(productionItems.sourceClipIdeaId, args.clipIdeaId));
}

export type AssignClipIdeaResult = {
  sourceProductionItemId: string;
  sourceTitle: string | null;
  sourceBrand: string;
  hook: string;
  editorName: string | null;
  editorEmail: string | null;
  newProductionItemId: string;
};

export type CreateClipIdeaInDescriptResult = AssignClipIdeaResult & {
  descriptProjectUrl: string;
  descriptJobId: string;
};

export class ClipIdeaNotFoundError extends Error {
  constructor() {
    super("Clip idea not found");
    this.name = "ClipIdeaNotFoundError";
  }
}

export class ClipIdeaAlreadyDecidedError extends Error {
  constructor(public readonly status: string) {
    super(`Clip idea already ${status}`);
    this.name = "ClipIdeaAlreadyDecidedError";
  }
}

export class ClipIdeaSourceMissingDescriptProjectError extends Error {
  constructor() {
    super("Source production item has no Descript project");
    this.name = "ClipIdeaSourceMissingDescriptProjectError";
  }
}

export class ClipIdeaSourceMissingMediaError extends Error {
  constructor() {
    super("Source production item has no archived media file");
    this.name = "ClipIdeaSourceMissingMediaError";
  }
}

export class ClipIdeaSeedCompositionMissingError extends Error {
  constructor(pillarId: string) {
    super(
      `Pillar ${pillarId} has a Descript project but no seed composition ID — run scripts/repair-mfm-descript-seed.mjs (or equivalent) before promoting`,
    );
    this.name = "ClipIdeaSeedCompositionMissingError";
  }
}

export class ClipIdeaProductionItemMissingError extends Error {
  constructor(clipIdeaId: string) {
    super(
      `No production_item exists for clip_idea ${clipIdeaId}. Run scripts/backfill-clip-idea-production-items.mjs.`,
    );
    this.name = "ClipIdeaProductionItemMissingError";
  }
}

export class FormatMissingSkillError extends Error {
  constructor(
    public readonly formatId: string,
    public readonly formatName: string,
    public readonly brand: string,
  ) {
    super(
      `Format "${formatName}" has no Skill defined. Open /${brand}/formats/${formatId} and fill in the Skill — the Descript Underlord reads it on every clip.`,
    );
    this.name = "FormatMissingSkillError";
  }
}

/**
 * Back-compat alias. Older callers still import this name; the underlying
 * concept is now "format skill" since the Descript-packs table was rolled
 * into `formats.instructions` (2026-05-11). Remove after one release.
 */
export const FormatMissingDescriptPackError = FormatMissingSkillError;

export class NoClippableFormatForBrandError extends Error {
  constructor(public readonly brand: string) {
    super(
      `No format on brand "${brand}" has is_clippable_format=true. Open /${brand}/formats and tick the "Clippable format" checkbox on the format that should receive clip-idea promotions.`,
    );
    this.name = "NoClippableFormatForBrandError";
  }
}

// Note: the error class was renamed from `NoClipDescriptFormatForBrandError`
// to `NoClippableFormatForBrandError` when the flag was generalized to allow
// multiple clippable formats per brand (2026-05-21). No back-compat alias —
// the rename was sweeping enough that callers were updated in the same
// commit and a stale alias would just rot.

/**
 * Resolve the "primary" clip-promotion format for a brand — the first row
 * with `is_clippable_format=true`, ordered by creation date. Used by
 * legacy default-target callers (Descript Create-in default, the promote
 * paths). When more than one clippable format exists, callers that
 * specifically know which format they want (e.g. the manual clip-ideas
 * generate route after the operator picks a format) should pass the
 * format id explicitly instead of relying on this helper.
 *
 * Returns `null` when no format on the brand is clippable — callers that
 * need a hard requirement should `throw new NoClippableFormatForBrandError`.
 */
export async function getPrimaryClippableFormat(
  brand: string,
): Promise<string | null> {
  const [row] = await db
    .select({ name: formats.name })
    .from(formats)
    .where(and(eq(formats.brand, brand), eq(formats.isClippableFormat, true)))
    .orderBy(formats.createdAt)
    .limit(1);
  return row?.name ?? null;
}

/**
 * Back-compat alias for callers still on the pre-2026-05-21 name. Returns
 * the same value as `getPrimaryClippableFormat`.
 */
export const getPromotedClipFormat = getPrimaryClippableFormat;

function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

interface ClipIdeaRow {
  id: string;
  status: string;
  hook: string;
  angle: string;
  rationale: string;
  startSec: string;
  endSec: string;
  estimatedViews: bigint | null;
  /** Per-clip-idea target format (since 2026-05-21 multi-format split).
   *  Null on legacy rows generated before the column existed — the promote
   *  path then falls back to `getPrimaryClippableFormat(brand)`. */
  targetFormat: string | null;
  /** Format-specific output payload (e.g. `{ quotables: ["…"] }` for X
   *  Quotables). Null when the target format didn't declare extras. */
  extras: Record<string, unknown> | null;
  sourceProductionItemId: string;
  sourceTitle: string | null;
  sourceBrand: string | null;
  descriptProjectId: string | null;
  descriptSeedCompositionId: string | null;
  descriptAccount: string | null;
  mediaS3Key: string | null;
}

async function loadAndGuardClipIdea(
  clipIdeaId: string,
): Promise<ClipIdeaRow> {
  const [row] = await db
    .select({
      id: clipIdeas.id,
      status: clipIdeas.status,
      hook: clipIdeas.hook,
      angle: clipIdeas.angle,
      rationale: clipIdeas.rationale,
      startSec: clipIdeas.startSec,
      endSec: clipIdeas.endSec,
      estimatedViews: clipIdeas.estimatedViews,
      targetFormat: clipIdeas.targetFormat,
      extras: clipIdeas.extras,
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
      sourceTitle: productionItems.title,
      sourceBrand: productionItems.brand,
      descriptProjectId: productionItems.descriptProjectId,
      descriptSeedCompositionId: productionItems.descriptSeedCompositionId,
      descriptAccount: productionItems.descriptAccount,
      mediaS3Key: productionItems.mediaS3Key,
    })
    .from(clipIdeas)
    .leftJoin(
      productionItems,
      eq(productionItems.id, clipIdeas.sourceProductionItemId),
    )
    .where(eq(clipIdeas.id, clipIdeaId))
    .limit(1);

  if (!row) throw new ClipIdeaNotFoundError();
  if (
    row.status === "killed" ||
    row.status === "accepted" ||
    row.status === "assigned"
  ) {
    throw new ClipIdeaAlreadyDecidedError(row.status);
  }
  return row as ClipIdeaRow;
}

/**
 * Look up the queue-side production_item already created for this clip idea
 * at generation time. Returns the row's id so the promote paths can UPDATE it
 * in place (rather than INSERT a new one and trip the partial unique index).
 * If somehow missing — only possible for pre-backfill historical rows — throw
 * so the caller can surface a "run the backfill" error rather than silently
 * creating a duplicate that bypasses the queue pre-creation invariant.
 */
async function loadClipProductionItemId(clipIdeaId: string): Promise<string> {
  const [row] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.sourceClipIdeaId, clipIdeaId))
    .limit(1);
  if (!row) throw new ClipIdeaProductionItemMissingError(clipIdeaId);
  return row.id;
}

function buildContentBody(row: ClipIdeaRow): string {
  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);
  const duration = Math.max(0, Math.round(endSec - startSec));
  const timestampRange = `${formatTimestamp(startSec)}–${formatTimestamp(endSec)} (${duration}s)`;
  return [
    `Source: ${row.sourceTitle ?? "(untitled)"}`,
    `Timestamp: ${timestampRange}`,
    "",
    `Angle: ${row.angle}`,
    "",
    `Why: ${row.rationale}`,
  ].join("\n");
}

async function loadEditor(
  editorUserId: string,
): Promise<{ name: string | null; email: string | null }> {
  const [editor] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, editorUserId))
    .limit(1);
  return { name: editor?.name ?? null, email: editor?.email ?? null };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Drop the clip-idea's hook + rationale + transcript excerpt as the first
 * comment on the new production_item. Gives the editor everything they need
 * to make the cut without having to bounce back to the per-pillar Clip Ideas
 * panel. Fire-and-forget — a comment-insert failure must never break the
 * promote path. Caller should `void` this.
 */
async function postClipPromotionComment(args: {
  productionItemId: string;
  actorUserId: string;
  row: ClipIdeaRow;
}): Promise<void> {
  const startSec = Number(args.row.startSec);
  const endSec = Number(args.row.endSec);

  // Pull transcript segments overlapping the clip range from the pillar's
  // transcript row. Same shape the preview API uses.
  const [t] = await db
    .select({ segments: transcripts.segments })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, args.row.sourceProductionItemId))
    .limit(1);
  const overlapping = (t?.segments ?? []).filter(
    (s) => s.endSec > startSec && s.startSec < endSec,
  );
  const transcriptText = overlapping
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");

  const formatTs = (sec: number) => {
    const total = Math.max(0, Math.floor(sec));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  const range = `${formatTs(startSec)}–${formatTs(endSec)} (${Math.max(0, Math.round(endSec - startSec))}s)`;

  const parts: string[] = [
    `<p><strong>Clip range:</strong> ${escapeHtml(range)}</p>`,
    `<p><strong>Hook</strong></p>`,
    `<blockquote>${escapeHtml(args.row.hook)}</blockquote>`,
    `<p><strong>Why it'll go viral</strong></p>`,
    `<p>${escapeHtml(args.row.rationale)}</p>`,
  ];
  if (transcriptText) {
    parts.push(`<p><strong>Transcript</strong></p>`);
    parts.push(`<p>${escapeHtml(transcriptText)}</p>`);
  }
  const body = parts.join("\n");

  await db.insert(contentComments).values({
    contentItemId: args.productionItemId,
    userId: args.actorUserId,
    body,
  });
}

export async function assignClipIdea(args: {
  clipIdeaId: string;
  editorUserId: string;
  decidedByUserId: string;
}): Promise<AssignClipIdeaResult> {
  const row = await loadAndGuardClipIdea(args.clipIdeaId);
  const editor = await loadEditor(args.editorUserId);
  const body = buildContentBody(row);
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);

  // Create the real production_items row. The partial uniq index on
  // source_clip_idea_id guarantees one production item per clip idea at
  // the DB. Editor = the assignee. Default platform = YouTube Shorts,
  // editor can swap on the detail page.
  let created: { id: string } | undefined;
  try {
    const brand = row.sourceBrand ?? "starter-story";
    // Use the clip idea's target_format (set by the multi-format clip-idea
    // generator) so a promoted X Quotables idea lands in the X Quotables
    // format, not the brand's first clippable. Legacy rows with null
    // target_format fall through to the brand default.
    const promotedFormat =
      row.targetFormat ?? (await getPrimaryClippableFormat(brand));
    if (!promotedFormat) throw new NoClippableFormatForBrandError(brand);
    const rows = await db
      .insert(productionItems)
      .values({
        title: row.hook,
        status: "Assigned",
        platform: ["YouTube Shorts"],
        format: promotedFormat,
        brand,
        contentBody: body,
        pillarContentItemId: row.sourceProductionItemId,
        sourceType: "repurposed",
        sourceClipIdeaId: args.clipIdeaId,
        editorUserId: args.editorUserId,
        utmCampaign: await generateUtmCampaign(row.hook),
        hook: row.hook,
        hookSource: "clip_idea",
        hookExtractedAt: new Date(),
        createdVia: "service:clip-promote",
      })
      .returning({ id: productionItems.id });
    created = rows[0];
    if (created) {
      try {
        await recordItemCreated(db, {
          itemId: created.id,
          source: "service:clip-promote",
          actorUserId: args.decidedByUserId ?? null,
          format: promotedFormat,
          sourceType: "repurposed",
          postType: null,
        });
      } catch (e) {
        console.error("[service:clip-promote] recordItemCreated failed", e);
      }
    }
  } catch (err) {
    // Translate the DB-level double-promote guard to the same 409 the
    // app-level status check uses. Happens on concurrent double-clicks or
    // retries that slip past the status check.
    if (isUniqueViolation(err, "uniq_production_items_source_clip_idea")) {
      throw new ClipIdeaAlreadyDecidedError("assigned");
    }
    throw err;
  }

  if (!created) throw new Error("Failed to create production item for clip");

  await db
    .update(clipIdeas)
    .set({
      status: "assigned",
      acceptedEditorUserId: args.editorUserId,
      acceptedProductionItemId: productionItemId,
      decidedAt: new Date(),
      decidedByUserId: args.decidedByUserId,
    })
    .where(eq(clipIdeas.id, args.clipIdeaId));

  // Fire-and-forget: kick the Draft Algorithm so the new clip lands with
  // a populated caption instead of an empty "Write a caption…" field.
  // `force: false` (default) prevents clobbering editor edits on retries
  // — see run.ts idempotency guard.
  try {
    await enqueue("draft-algorithm-run", { productionItemId });
  } catch (err) {
    console.error("draft-algorithm-run enqueue (clip-assign) failed:", err);
  }

  return {
    sourceProductionItemId: row.sourceProductionItemId,
    sourceTitle: row.sourceTitle,
    sourceBrand: row.sourceBrand ?? "starter-story",
    hook: row.hook,
    editorName: editor.name,
    editorEmail: editor.email,
    newProductionItemId: productionItemId,
  };
}

interface PromotedClipFormat {
  id: string;
  name: string;
  brand: string;
  /** The format's Skill (formats.instructions) — sent to the Descript
   *  Underlord verbatim, with `{{hook}}` / timestamp placeholders
   *  substituted. Replaces the descript_packs table (rolled into Skill
   *  on 2026-05-11). Throws `FormatMissingSkillError` when empty. */
  skill: string;
  /** Clip aspect ratio from `formats.clip_aspect_ratio` — drives the
   *  Descript composition layout. Null = fall back to post-type default
   *  via `resolveClipAspectRatio`. */
  clipAspectRatio: string | null;
  /** Target post type — drives the {@link resolveClipAspectRatio} fallback
   *  when `clipAspectRatio` is null. */
  clipTargetPostType: string | null;
}

/**
 * Resolve the format a clip idea is being promoted into and load its Skill.
 * When `targetFormatName` is provided (post-2026-05-21 multi-format world,
 * sourced from `clip_ideas.target_format`), use that format — different
 * clippable formats have different Descript packs, aspect ratios, and
 * extras shapes. Fall back to the brand's first clippable format ordered
 * by created_at for legacy rows whose target_format wasn't backfilled.
 *
 * Throws `FormatMissingSkillError` when the matched format's Skill is
 * empty so the four create-in-descript service functions gate uniformly
 * (Pat's "don't let me generate anything in Descript unless the format
 * has a prompt" rule).
 */
export async function loadPromotedClipFormat(args: {
  brand: string;
  targetFormatName: string | null;
  /** When false, don't throw `FormatMissingSkillError` for a format with no
   *  Skill/pack — used by Buffered Cut, which never runs Underlord and so
   *  doesn't need one. Defaults to true (the styling paths require a Skill). */
  requireSkill?: boolean;
}): Promise<PromotedClipFormat> {
  const cols = {
    id: formats.id,
    name: formats.name,
    brand: formats.brand,
    skill: formats.instructions,
    clipAspectRatio: formats.clipAspectRatio,
    clipTargetPostType: formats.clipTargetPostType,
  };
  const brandClippable = and(
    eq(formats.brand, args.brand),
    eq(formats.isClippableFormat, true),
  );

  // Prefer an exact name match on the clip idea's stored target_format.
  let row = args.targetFormatName
    ? (
        await db
          .select(cols)
          .from(formats)
          .where(and(brandClippable, eq(formats.name, args.targetFormatName)))
          .limit(1)
      )[0]
    : undefined;

  // No exact match — the stored target_format is stale (the format was
  // renamed after this idea was generated) or null (legacy pre-multi-format
  // rows). Fall back to the brand's primary clippable format, same contract
  // as getPrimaryClippableFormat. Throwing here would surface as a bare
  // "Failed (502)" in the promote UI; degrading to the brand default keeps
  // the clip promotable.
  if (!row) {
    if (args.targetFormatName) {
      console.warn(
        `loadPromotedClipFormat: target_format "${args.targetFormatName}" did not match a clippable format on brand "${args.brand}"; falling back to the brand's primary clippable format.`,
      );
    }
    row = (
      await db
        .select(cols)
        .from(formats)
        .where(brandClippable)
        .orderBy(formats.createdAt)
        .limit(1)
    )[0];
  }

  if (!row) throw new NoClippableFormatForBrandError(args.brand);
  if ((args.requireSkill ?? true) && (!row.skill || !row.skill.trim())) {
    throw new FormatMissingSkillError(row.id, row.name, row.brand);
  }
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    skill: row.skill ?? "",
    clipAspectRatio: row.clipAspectRatio,
    clipTargetPostType: row.clipTargetPostType,
  };
}


export function buildDescriptPrompt(args: {
  skill: string;
  hook: string;
  startSec: number;
  endSec: number;
  productionItemId: string;
  aspectRatio: "9:16" | "16:9";
  quotables: string[];
  /** The full-length source composition to cut from. When present, the prompt
   *  names it explicitly so Underlord doesn't guess among multiple compositions
   *  in the project. Null = fall back to the ambiguous "main composition"
   *  wording (back-compat for pillars where the seed hasn't been set). */
  sourceCompositionId?: string | null;
}): string {
  const duration = Math.max(0, Math.round(args.endSec - args.startSec));
  const start = formatTimestamp(args.startSec);
  const end = formatTimestamp(args.endSec);
  const compositionName = buildCompositionName({
    title: args.hook,
    productionItemId: args.productionItemId,
  });
  const safeHook = compositionName.replace(/"/g, '\\"');
  // Underlord only needs the operational Descript section of the Skill —
  // the editorial sections (Hook, Clip guidance, Avoid) are for Claude /
  // the dispatcher. Falls back to the whole Skill when no Descript
  // section heading exists (back-compat for older formats).
  const descriptOnly = extractDescriptSection(args.skill);
  const inner = substituteFormatPrompt(descriptOnly, {
    hook: args.hook,
    startSec: args.startSec,
    endSec: args.endSec,
    aspectRatio: args.aspectRatio,
    quotables: args.quotables,
  });
  const orientationLine =
    args.aspectRatio === "16:9"
      ? "You are producing a horizontal 16:9 clip. Follow these instructions exactly and do not deviate."
      : "You are producing a vertical 9:16 clip. Follow these instructions exactly and do not deviate.";
  return [
    orientationLine,
    "",
    args.sourceCompositionId
      ? `1. In the source composition (compositionId="${args.sourceCompositionId}"), locate the transcript segment between ${start} and ${end} (duration ≈ ${duration}s). The time range is non-negotiable. Do NOT edit or trim this source composition — only read from it.`
      : `1. In the main composition, locate the transcript segment between ${start} and ${end} (duration ≈ ${duration}s). The time range is non-negotiable.`,
    `2. Create a NEW composition named "${safeHook}" containing only that segment. Do not include footage outside this range. The start must land on the first spoken word inside the range; the end must land on the last spoken word inside the range.`,
    "",
    "3. Apply the following format-specific instructions to the new composition:",
    "",
    inner,
    "",
    'If any instruction conflicts with another, prioritize #1 (exact time range) and #2 (no footage outside the range). In the agent response, report what you did, including the new compositionId in the form compositionId="<uuid>".',
  ].join("\n");
}

/**
 * Promote a clip idea by cutting a Descript composition at its exact
 * [startSec, endSec] range. Updates the pre-created production_items row
 * (editor=actor) to status="Assigned", invokes Descript's
 * agent with a timestamp-pinned prompt, logs a repurpose_triggers row, and
 * enqueues the poller task that writes descriptCompositionId back when the
 * job stops. The clip idea transitions to "assigned" exactly like the assign
 * path — same terminal state.
 *
 * The agent path requires a pre-existing Descript project on the source
 * (Underlord works by adding a new composition to an existing project).
 * When the source has `mediaS3Key` but no Descript project yet — the
 * common case now that Whisper transcripts don't require a Descript
 * project upfront — we transparently fall through to the precise-cut
 * path (ffmpeg-trim → new Descript project) so users get a clip without
 * having to set up Descript manually first.
 */
export async function createClipIdeaInDescript(args: {
  clipIdeaId: string;
  actorUserId: string;
}): Promise<CreateClipIdeaInDescriptResult | CreateClipIdeaInDescriptPreciseCutResult> {
  const row = await loadAndGuardClipIdea(args.clipIdeaId);
  if (!row.descriptProjectId) {
    if (row.mediaS3Key) {
      // Fall through to precise-cut, but inherit the AI intent: the user
      // clicked the agent button (which always applies the layout pack), so
      // when we can't run the agent path we still want the pack applied to
      // the imported composition.
      return createClipIdeaInDescriptPreciseCut({ ...args, applyLayoutPack: true });
    }
    throw new ClipIdeaSourceMissingDescriptProjectError();
  }
  // Project exists but seed is missing: Underlord would silently pick the wrong
  // "main" composition as source. Fail loudly so the pillar can be repaired.
  if (!row.descriptSeedCompositionId) {
    throw new ClipIdeaSeedCompositionMissingError(row.sourceProductionItemId);
  }
  const brand = row.sourceBrand ?? "starter-story";
  const editor = await loadEditor(args.actorUserId);
  const body = buildContentBody(row);
  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);

  // Load the brand-specific clip-promotion format with its Descript pack.
  // This ensures the format row exists and has a pack attached (guard against
  // the "No Descript pack attached" error the user saw).
  const format = await loadPromotedClipFormat({
    brand,
    targetFormatName: row.targetFormat,
  });

  const aspectRatio = resolveClipAspectRatio({
    clipAspectRatio: format.clipAspectRatio,
    clipTargetPostType: format.clipTargetPostType,
  });
  const quotables = extractQuotablesFromExtras(row.extras);
  const prompt = buildDescriptPrompt({
    skill: format.skill,
    hook: row.hook,
    startSec,
    endSec,
    productionItemId,
    aspectRatio,
    quotables,
    sourceCompositionId: row.descriptSeedCompositionId,
  });
  const agent = await invokeDescriptAgent({
    projectId: row.descriptProjectId,
    prompt,
    caller: "clip-idea-promote-agent",
    productionItemId,
    account: row.descriptAccount,
  });

  // Promote the pre-created draft production_item (the row that
  // clip-idea generation seeds for every idea) — flip it to Assigned and
  // stamp the Descript IDs we just got from the agent call. Mirrors the
  // precise-cut path's update pattern. Earlier versions of this function
  // INSERTed a new row here, but every promote now collides on the
  // unique (source_clip_idea_id) index because the pre-create already
  // occupies that slot — manifested as the route's catch-all 502.
  await db
    .update(productionItems)
    .set({
      status: "Assigned",
      title: row.hook,
      hook: row.hook,
      hookSource: "clip_idea",
      hookExtractedAt: new Date(),
      contentBody: body,
      editorUserId: args.actorUserId,
      descriptProjectId: row.descriptProjectId,
      descriptProjectUrl: agent.projectUrl,
      descriptAccount: row.descriptAccount,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, productionItemId));

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: row.sourceProductionItemId,
      targetFormatId: format.id,
      descriptJobId: agent.jobId,
      descriptProjectUrl: agent.projectUrl,
      descriptPrompt: prompt,
      compositionName: row.hook,
      descriptImportPath: "agent",
    })
    .returning({ id: repurposeTriggers.id });

  // Pre-emit the in-progress activity event so the new content detail page
  // shows "Cutting clip in Descript…" instantly on navigation, instead of
  // sitting blank for ~60-90s until the worker writes the first
  // `clip_created` event. The dot palette renders status:"info" as a
  // neutral grey, matching the "still happening" semantics.
  await recordToolAction({
    contentItemId: productionItemId,
    userId: args.actorUserId,
    tool: "descript",
    action: "kicking_off",
    status: "info",
    label: "Cutting clip in Descript (Underlord)… composition incoming.",
    url: agent.projectUrl,
    meta: { importPath: "agent" },
  });

  await enqueue("descript-clip-resolve", {
    triggerId: trigger.id,
    jobId: agent.jobId,
    derivativeItemId: productionItemId,
  });

  await db
    .update(clipIdeas)
    .set({
      status: "assigned",
      acceptedEditorUserId: args.actorUserId,
      acceptedProductionItemId: productionItemId,
      decidedAt: new Date(),
      decidedByUserId: args.actorUserId,
    })
    .where(eq(clipIdeas.id, args.clipIdeaId));

  await postClipPromotionComment({
    productionItemId,
    actorUserId: args.actorUserId,
    row,
  });

  // Fire-and-forget Draft Algorithm. Mirrors the cross-post / repurpose
  // routes; the algo's `force: false` guard keeps retries idempotent.
  try {
    await enqueue("draft-algorithm-run", { productionItemId });
  } catch (err) {
    console.error("draft-algorithm-run enqueue (clip-descript) failed:", err);
  }

  return {
    sourceProductionItemId: row.sourceProductionItemId,
    sourceTitle: row.sourceTitle,
    sourceBrand: brand,
    hook: row.hook,
    editorName: editor.name,
    editorEmail: editor.email,
    newProductionItemId: productionItemId,
    descriptProjectUrl: agent.projectUrl,
    descriptJobId: agent.jobId,
  };
}

export type CreateClipIdeaInDescriptPreciseCutResult = AssignClipIdeaResult;

/**
 * Precise-cut promotion: flip the pre-created production_item to Assigned and
 * enqueue `clip-idea-precise-cut` which does the slow work — S3 download,
 * ffmpeg trim, Descript upload, job poll. Unlike the agent flow, we don't
 * have descriptProjectId / descriptProjectUrl yet; the worker backfills both
 * onto the production_item and the trigger when the import job stops.
 * Different from createClipIdeaInDescript in three ways: (1) requires a
 * source mediaS3Key, not a Descript project; (2) creates a NEW Descript
 * project per clip (import endpoint doesn't accept project_id); (3) no
 * agent / LLM in the loop — Descript receives a pre-trimmed file.
 */
export async function createClipIdeaInDescriptPreciseCut(args: {
  clipIdeaId: string;
  actorUserId: string;
  /** When true, the worker invokes Underlord post-import to apply the
   *  configured layout pack to the imported composition. Set by the
   *  agent-path fall-through when a Descript project doesn't exist yet. */
  applyLayoutPack: boolean;
  /** When true, ffmpeg trims to 60s before/after Claude's suggested range
   *  instead of the exact timestamps, giving editors room to extend the clip.
   *  The original startSec/endSec are preserved as Claude's recommendation. */
  buffered?: boolean;
}): Promise<CreateClipIdeaInDescriptPreciseCutResult> {
  const row = await loadAndGuardClipIdea(args.clipIdeaId);
  if (!row.mediaS3Key) {
    throw new ClipIdeaSourceMissingMediaError();
  }
  const brand = row.sourceBrand ?? "starter-story";
  const editor = await loadEditor(args.actorUserId);
  const body = buildContentBody(row);
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);
  // Which workspace the new Descript project lands in follows the clicker,
  // not a global default — see resolveDescriptAccountForActor.
  const descriptAccount = resolveDescriptAccountForActor(editor.email);

  // Precise Cut requires a Skill/pack (throws FormatMissingDescriptPackError
  // before any side effects — the worker re-loads the pack for the layout
  // phase, and the gate here prevents enqueuing a job that would no-op).
  // Buffered Cut runs no Underlord call, so it works for formats with no
  // pack (e.g. X Quotables) — we still load the format for its id/aspect,
  // just don't require a Skill.
  const format = await loadPromotedClipFormat({
    brand,
    targetFormatName: row.targetFormat,
    requireSkill: !args.buffered,
  });

  await db
    .update(productionItems)
    .set({
      status: "Assigned",
      title: row.hook,
      hook: row.hook,
      contentBody: body,
      editorUserId: args.actorUserId,
      descriptAccount,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, productionItemId));

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: row.sourceProductionItemId,
      targetFormatId: format.id,
      compositionName: row.hook,
      descriptImportPath: "precise-cut",
    })
    .returning({ id: repurposeTriggers.id });

  const BUFFER_SEC = 60;
  const cutStartSec = args.buffered
    ? Math.max(0, Number(row.startSec) - BUFFER_SEC)
    : undefined;
  const cutEndSec = args.buffered
    ? Number(row.endSec) + BUFFER_SEC
    : undefined;

  // Buffered Cut never runs the Underlord layout-pack call — it's a plain
  // trim that imports as-is (source orientation) so the editor has room to
  // finalize the boundaries and style it themselves. Enforced here at the
  // service layer so it doesn't depend on the route passing `ai=1` or not.
  const effectiveApplyLayoutPack = args.buffered ? false : args.applyLayoutPack;

  await recordToolAction({
    contentItemId: productionItemId,
    userId: args.actorUserId,
    tool: "descript",
    action: "kicking_off",
    status: "info",
    label: args.buffered
      ? "Trimming with 60-second buffer and uploading to Descript… new composition incoming."
      : "Trimming clip locally + uploading to Descript… new composition incoming.",
    meta: {
      importPath: "precise-cut",
      applyLayoutPack: effectiveApplyLayoutPack ? 1 : 0,
      buffered: args.buffered ? 1 : 0,
    },
  });

  await enqueue(
    "clip-idea-precise-cut",
    {
      clipIdeaId: args.clipIdeaId,
      triggerId: trigger.id,
      derivativeItemId: productionItemId,
      descriptAccount,
      applyLayoutPack: effectiveApplyLayoutPack,
      ...(cutStartSec !== undefined ? { cutStartSec } : {}),
      ...(cutEndSec !== undefined ? { cutEndSec } : {}),
    },
    // jobKey: at most one pending cut per clip; queueName serializes heavy
    // media work — two concurrent ffmpeg cuts R15'd the worker (2026-08-09).
    {
      jobKey: `precise-cut:${args.clipIdeaId}`,
      jobKeyMode: "replace",
      queueName: "media-heavy",
    },
  );

  await db
    .update(clipIdeas)
    .set({
      status: "assigned",
      acceptedEditorUserId: args.actorUserId,
      acceptedProductionItemId: productionItemId,
      decidedAt: new Date(),
      decidedByUserId: args.actorUserId,
    })
    .where(eq(clipIdeas.id, args.clipIdeaId));

  await postClipPromotionComment({
    productionItemId,
    actorUserId: args.actorUserId,
    row,
  });

  // Fire-and-forget Draft Algorithm. Safe to fire before the precise-cut
  // worker finishes — the algo grounds copy in the pillar transcript +
  // format Skill, not in the clipped video bytes.
  try {
    await enqueue("draft-algorithm-run", { productionItemId });
  } catch (err) {
    console.error(
      "draft-algorithm-run enqueue (clip-precise-cut) failed:",
      err,
    );
  }

  return {
    sourceProductionItemId: row.sourceProductionItemId,
    sourceTitle: row.sourceTitle,
    sourceBrand: brand,
    hook: row.hook,
    editorName: editor.name,
    editorEmail: editor.email,
    newProductionItemId: productionItemId,
  };
}

export type CreateClipIdeaInDescriptFullVideoResult = AssignClipIdeaResult & {
  descriptProjectUrl: string | null;
  descriptJobId: string;
  /** "warm" when the pillar already had a Descript project (we duplicated
   *  the composition); "cold" when we uploaded the pillar to Descript for
   *  the first time. The cold path stamps the pillar so the next clip from
   *  the same pillar takes the warm path. */
  mode: "warm" | "cold";
  /** True when the duplicated composition was trimmed to the clip idea's
   *  [startSec, endSec]. Only the warm path can do this — a cold import
   *  creates the composition asynchronously, so there is nothing to trim
   *  yet and the caller is told so rather than being quietly ignored. */
  rangeApplied: boolean;
};

/**
 * Full-video promotion: hand the editor the entire pillar inside Descript so
 * they can trim manually. Two paths:
 *
 *   - WARM: pillar already has a `descriptProjectId` + `descriptCompositionId`.
 *     Just duplicate the existing composition (agent prompt). Cheap, no
 *     re-upload.
 *   - COLD: pillar has only an `mediaS3Key`. Upload it to Descript via a
 *     presigned-URL import (Descript fetches the URL itself — no streaming
 *     bytes through our worker). Stamp the new project_id + project_url on
 *     the pillar so this is done exactly once. The first clip's working
 *     composition IS the imported source composition; future clips from the
 *     same pillar take the warm path and get a duplicate.
 *
 * Either way, the clip prod_item flips to Assigned with the pillar's
 * project_id + project_url. The new compositionId fills in async via the
 * existing `descript-clip-resolve` poller (extended to handle import jobs).
 */
export async function createClipIdeaInDescriptFullVideo(args: {
  clipIdeaId: string;
  actorUserId: string;
  /** Trim the duplicated composition to the clip idea's timestamps instead
   *  of handing over the whole pillar. The media stays whole in the project,
   *  so the editor can still drag the boundaries out by hand — that's the
   *  point of this path versus the precise cut (which ffmpeg-trims bytes). */
  trimToClipRange?: boolean;
}): Promise<CreateClipIdeaInDescriptFullVideoResult> {
  const row = await loadAndGuardClipIdea(args.clipIdeaId);
  const editor = await loadEditor(args.actorUserId);
  const body = buildContentBody(row);
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);
  const brand = row.sourceBrand ?? "starter-story";
  // Gate uniformly with the agent + precise-cut paths even though the
  // warm path doesn't actually use the pack today — Pat's directive is
  // "don't let me generate anything in Descript unless I have a prompt
  // set at the format level."
  const format = await loadPromotedClipFormat({
    brand,
    targetFormatName: row.targetFormat,
  });

  // Re-fetch the pillar — `loadAndGuardClipIdea` only returns mediaS3Key /
  // descriptProjectId, but the warm path also needs descriptSeedCompositionId
  // and descriptProjectUrl, and we may need to write back to the pillar.
  const [pillar] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      descriptProjectId: productionItems.descriptProjectId,
      descriptProjectUrl: productionItems.descriptProjectUrl,
      descriptSeedCompositionId: productionItems.descriptSeedCompositionId,
      descriptAccount: productionItems.descriptAccount,
      mediaS3Key: productionItems.mediaS3Key,
    })
    .from(productionItems)
    .where(eq(productionItems.id, row.sourceProductionItemId))
    .limit(1);
  if (!pillar) throw new ClipIdeaNotFoundError();

  let mode: "warm" | "cold";
  let jobId: string;
  let projectId: string;
  let projectUrl: string | null;
  let descriptPrompt: string | null;
  let pillarItemIdToStamp: string | undefined;
  let importMode = false;
  let rangeApplied = false;

  // Project imported but seed never captured (or was corrupted). The warm path
  // needs both; the cold path would try to re-import and fail with a confusing
  // "cold-imported concurrently" error. Fail clearly instead.
  if (pillar.descriptProjectId && !pillar.descriptSeedCompositionId) {
    throw new ClipIdeaSeedCompositionMissingError(pillar.id);
  }

  if (pillar.descriptProjectId && pillar.descriptSeedCompositionId) {
    mode = "warm";
    rangeApplied = args.trimToClipRange === true;
    const dup = await duplicateDescriptComposition({
      projectId: pillar.descriptProjectId,
      sourceCompositionId: pillar.descriptSeedCompositionId,
      newCompositionName: buildCompositionName({
        title: row.hook,
        productionItemId,
      }),
      caller: rangeApplied
        ? "clip-idea-promote-duplicate-range"
        : "clip-idea-promote-full-video",
      productionItemId,
      account: pillar.descriptAccount,
      rangeSec: rangeApplied
        ? { startSec: Number(row.startSec), endSec: Number(row.endSec) }
        : null,
    });
    jobId = dup.jobId;
    projectId = dup.projectId;
    projectUrl = pillar.descriptProjectUrl ?? dup.projectUrl ?? null;
    descriptPrompt = dup.prompt;
  } else if (pillar.mediaS3Key) {
    mode = "cold";
    // Shared helper takes the SELECT … FOR UPDATE lock on the pillar,
    // double-checks descriptProjectId after locking, and stamps the pillar
    // with project_id + project_url + descript_imported_at. The new
    // composition's id arrives async via descript-clip-resolve and is
    // written to the pillar's `descript_seed_composition_id`.
    const importRes = await coldImportPillar({ pillarId: pillar.id, account: "hubspot" });
    if (!importRes.imported) {
      // Race: another caller imported this pillar between our pillar read
      // and the helper's lock acquisition. Surface the conflict instead of
      // silently double-importing or quietly mismatching state.
      throw new Error(
        `Pillar ${pillar.id} was cold-imported concurrently; retry promotion in a moment`,
      );
    }
    jobId = importRes.jobId;
    projectId = importRes.projectId;
    projectUrl = importRes.projectUrl;
    descriptPrompt = null;
    pillarItemIdToStamp = pillar.id;
    importMode = true;
  } else {
    throw new ClipIdeaSourceMissingMediaError();
  }

  // Flip the clip prod_item to Assigned with the pillar's project IDs.
  await db
    .update(productionItems)
    .set({
      status: "Assigned",
      title: row.hook,
      hook: row.hook,
      hookSource: "clip_idea",
      hookExtractor: "promote-clip-idea:v1",
      hookExtractedAt: new Date(),
      contentBody: body,
      editorUserId: args.actorUserId,
      descriptProjectId: projectId,
      descriptProjectUrl: projectUrl,
      descriptAccount: mode === "cold" ? "hubspot" : pillar.descriptAccount,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, productionItemId));

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: row.sourceProductionItemId,
      targetFormatId: format.id,
      descriptJobId: jobId,
      descriptProjectUrl: projectUrl,
      descriptPrompt,
      compositionName: row.hook,
      descriptImportPath: rangeApplied ? "full-video-range" : "full-video",
    })
    .returning({ id: repurposeTriggers.id });

  await recordToolAction({
    contentItemId: productionItemId,
    userId: args.actorUserId,
    tool: "descript",
    action: "kicking_off",
    status: "info",
    label:
      mode === "cold"
        ? "Uploading the full pillar to Descript… composition incoming."
        : rangeApplied
          ? "Duplicating the pillar composition and trimming it to the clip's range… composition incoming."
          : "Duplicating the pillar composition in Descript… composition incoming.",
    url: projectUrl,
    meta: {
      importPath: rangeApplied ? "full-video-range" : "full-video",
      mode,
    },
  });

  await enqueue("descript-clip-resolve", {
    triggerId: trigger.id,
    jobId,
    derivativeItemId: productionItemId,
    pillarItemId: pillarItemIdToStamp,
    importMode,
  });

  await db
    .update(clipIdeas)
    .set({
      status: "assigned",
      acceptedEditorUserId: args.actorUserId,
      acceptedProductionItemId: productionItemId,
      decidedAt: new Date(),
      decidedByUserId: args.actorUserId,
    })
    .where(eq(clipIdeas.id, args.clipIdeaId));

  await postClipPromotionComment({
    productionItemId,
    actorUserId: args.actorUserId,
    row,
  });

  // Fire-and-forget Draft Algorithm. Same pillar transcript grounding the
  // other clip-promote paths use.
  try {
    await enqueue("draft-algorithm-run", { productionItemId });
  } catch (err) {
    console.error(
      "draft-algorithm-run enqueue (clip-full-video) failed:",
      err,
    );
  }

  return {
    sourceProductionItemId: row.sourceProductionItemId,
    sourceTitle: row.sourceTitle,
    sourceBrand: brand,
    hook: row.hook,
    editorName: editor.name,
    editorEmail: editor.email,
    newProductionItemId: productionItemId,
    descriptProjectUrl: projectUrl,
    descriptJobId: jobId,
    mode,
    rangeApplied,
  };
}
