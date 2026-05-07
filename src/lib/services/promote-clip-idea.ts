import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  contentComments,
  descriptPacks,
  formats,
  productionItems,
  repurposeTriggers,
  transcripts,
  users,
} from "@/lib/db/schema";
import {
  createDescriptProjectFromUrl,
  duplicateDescriptComposition,
  invokeDescriptAgent,
  substituteFormatPrompt,
} from "@/lib/descript";
import { getPresignedGetUrl } from "@/lib/s3";
import { enqueue } from "@/jobs/enqueue";

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

export class ClipIdeaProductionItemMissingError extends Error {
  constructor(clipIdeaId: string) {
    super(
      `No production_item exists for clip_idea ${clipIdeaId}. Run scripts/backfill-clip-idea-production-items.mjs.`,
    );
    this.name = "ClipIdeaProductionItemMissingError";
  }
}

export class FormatMissingDescriptPackError extends Error {
  constructor(
    public readonly formatId: string,
    public readonly formatName: string,
    public readonly brand: string,
  ) {
    super(
      `Format "${formatName}" has no Descript pack attached. Set one at /${brand}/formats/${formatId}.`,
    );
    this.name = "FormatMissingDescriptPackError";
  }
}

/**
 * Brand-specific short-form formats for clip promotion. Each brand has its own
 * preferred format with a Descript pack attached. This prevents the hardcoded
 * format issue from recurring where MATG clips were assigned Starter Story's
 * format name instead of their own.
 */
const PROMOTED_CLIP_FORMAT_BY_BRAND: Record<string, string> = {
  "starter-story": "Reel: Repackage Section w/ Hook",
  "matg": "Podcast Clip With Hook",
  "my-first-million": "Repackage section with hook",
  "futurepedia": "Repackage section with hook",
};

export function getPromotedClipFormat(brand: string): string {
  return PROMOTED_CLIP_FORMAT_BY_BRAND[brand] || "Repackage section with hook";
}

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
  sourceProductionItemId: string;
  sourceTitle: string | null;
  sourceBrand: string | null;
  descriptProjectId: string | null;
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
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
      sourceTitle: productionItems.title,
      sourceBrand: productionItems.brand,
      descriptProjectId: productionItems.descriptProjectId,
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

  // Create the real production_items row. sourceType='clip' bypasses the
  // uniq(pillar, format) index, which is scoped to 'original' — many clips
  // per pillar+format is the whole point. The partial uniq index on
  // source_clip_idea_id is the replacement guarantee: one production item
  // per clip idea, enforced at the DB. Default producer = the admin who
  // assigned; editor = the assignee. Default platform = YouTube Shorts,
  // editor can swap on the detail page.
  let created: { id: string } | undefined;
  try {
    const brand = row.sourceBrand ?? "starter-story";
    const rows = await db
      .insert(productionItems)
      .values({
        title: row.hook,
        status: "Assigned",
        platform: ["YouTube Shorts"],
        format: getPromotedClipFormat(brand),
        brand,
        contentBody: body,
        pillarContentItemId: row.sourceProductionItemId,
        sourceType: "clip",
        sourceClipIdeaId: args.clipIdeaId,
        producerUserId: args.decidedByUserId,
        editorUserId: args.editorUserId,
        hook: row.hook,
        hookSource: "clip_idea",
        hookExtractedAt: new Date(),
      })
      .returning({ id: productionItems.id });
    created = rows[0];
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
  /** Loaded from the attached descript_packs row. Always present — the
   *  caller is `loadPromotedClipFormat` which throws
   *  `FormatMissingDescriptPackError` before returning when null. */
  packPrompt: string;
}

/**
 * Find or create the canonical "Repackage section with hook" format for a
 * brand, then load its attached Descript pack. Throws
 * `FormatMissingDescriptPackError` when no pack is attached so the
 * three create-in-descript service functions all gate uniformly on the
 * pack being present (Pat's "don't let me generate anything in Descript
 * unless I have a prompt set" rule).
 */
async function loadPromotedClipFormat(brand: string): Promise<PromotedClipFormat> {
  const formatId = await ensurePromotedClipFormat(brand);
  const [row] = await db
    .select({
      id: formats.id,
      name: formats.name,
      brand: formats.brand,
      packPrompt: descriptPacks.prompt,
    })
    .from(formats)
    .leftJoin(descriptPacks, eq(formats.descriptPackId, descriptPacks.id))
    .where(eq(formats.id, formatId))
    .limit(1);
  if (!row) {
    throw new Error(`Format ${formatId} disappeared between insert and read`);
  }
  if (!row.packPrompt) {
    throw new FormatMissingDescriptPackError(row.id, row.name, row.brand);
  }
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    packPrompt: row.packPrompt,
  };
}

async function ensurePromotedClipFormat(brand: string, formatName: string): Promise<string> {
  const [existing] = await db
    .select({ id: formats.id })
    .from(formats)
    .where(
      and(eq(formats.name, formatName), eq(formats.brand, brand)),
    )
    .limit(1);
  if (existing) return existing.id;

  // formats.name is globally unique (not scoped by brand). If the row exists
  // under a different brand, adopt it by updating brand — a single format
  // row per name is the schema's invariant, and the assign flow stamps the
  // same name regardless of brand anyway.
  const [byName] = await db
    .select({ id: formats.id })
    .from(formats)
    .where(eq(formats.name, formatName))
    .limit(1);
  if (byName) return byName.id;

  const [created] = await db
    .insert(formats)
    .values({ name: formatName, brand })
    .returning({ id: formats.id });
  if (!created) {
    throw new Error(
      `Failed to create format row "${formatName}" for brand "${brand}"`,
    );
  }
  return created.id;
}

function buildDescriptPrompt(args: {
  packPrompt: string;
  hook: string;
  startSec: number;
  endSec: number;
}): string {
  const duration = Math.max(0, Math.round(args.endSec - args.startSec));
  const start = formatTimestamp(args.startSec);
  const end = formatTimestamp(args.endSec);
  const safeHook = args.hook.replace(/"/g, '\\"');
  const inner = substituteFormatPrompt(args.packPrompt, {
    hook: args.hook,
    startSec: args.startSec,
    endSec: args.endSec,
  });
  return [
    "You are producing a short-form vertical clip. Follow these instructions exactly and do not deviate.",
    "",
    `1. In the main composition, locate the transcript segment between ${start} and ${end} (duration ≈ ${duration}s). The time range is non-negotiable.`,
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
 * (editor=actor, producer=actor) to status="Assigned", invokes Descript's
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
  const brand = row.sourceBrand ?? "starter-story";
  const formatName = getPromotedClipFormat(brand);
  const editor = await loadEditor(args.actorUserId);
  const body = buildContentBody(row);
  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);

  // repurpose_triggers.target_format_id is NOT NULL. Ensure the brand-specific
  // format row exists for this brand and reuse it across every clip-idea
  // promotion — same name we stamp on productionItems.format. Matches the
  // existing assign flow's string value, now backed by an actual row the FK can reference.
  const formatId = await ensurePromotedClipFormat(brand, formatName);

  const prompt = buildDescriptPrompt({
    packPrompt: format.packPrompt,
    hook: row.hook,
    startSec,
    endSec,
  });
  const agent = await invokeDescriptAgent({
    projectId: row.descriptProjectId,
    prompt,
  });

  let created: { id: string } | undefined;
  try {
    const rows = await db
      .insert(productionItems)
      .values({
        title: row.hook,
        status: "Assigned",
        platform: ["YouTube Shorts"],
        format: formatName,
        brand,
        contentBody: body,
        pillarContentItemId: row.sourceProductionItemId,
        sourceType: "clip",
        sourceClipIdeaId: args.clipIdeaId,
        producerUserId: args.actorUserId,
        editorUserId: args.actorUserId,
        descriptProjectId: row.descriptProjectId,
        descriptProjectUrl: agent.projectUrl,
        hook: row.hook,
        hookSource: "clip_idea",
        hookExtractedAt: new Date(),
      })
      .returning({ id: productionItems.id });
    created = rows[0];
  } catch (err) {
    if (isUniqueViolation(err, "uniq_production_items_source_clip_idea")) {
      throw new ClipIdeaAlreadyDecidedError("assigned");
    }
    throw err;
  }
  if (!created) throw new Error("Failed to create production item for clip");

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
   *  "Precise cut + Underlord" button (or by the agent-path fall-through
   *  when a Descript project doesn't exist yet). */
  applyLayoutPack: boolean;
}): Promise<CreateClipIdeaInDescriptPreciseCutResult> {
  const row = await loadAndGuardClipIdea(args.clipIdeaId);
  if (!row.mediaS3Key) {
    throw new ClipIdeaSourceMissingMediaError();
  }
  const brand = row.sourceBrand ?? "starter-story";
  const formatName = getPromotedClipFormat(brand);
  const editor = await loadEditor(args.actorUserId);
  const body = buildContentBody(row);
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);

  const formatId = await ensurePromotedClipFormat(brand, formatName);

  let created: { id: string } | undefined;
  try {
    const rows = await db
      .insert(productionItems)
      .values({
        title: row.hook,
        status: "Assigned",
        platform: ["YouTube Shorts"],
        format: formatName,
        brand,
        contentBody: body,
        pillarContentItemId: row.sourceProductionItemId,
        sourceType: "clip",
        sourceClipIdeaId: args.clipIdeaId,
        producerUserId: args.actorUserId,
        editorUserId: args.actorUserId,
        hook: row.hook,
        hookSource: "clip_idea",
        hookExtractedAt: new Date(),
      })
      .returning({ id: productionItems.id });
    created = rows[0];
  } catch (err) {
    if (isUniqueViolation(err, "uniq_production_items_source_clip_idea")) {
      throw new ClipIdeaAlreadyDecidedError("assigned");
    }
    throw err;
  }
  if (!created) throw new Error("Failed to create production item for clip");

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: row.sourceProductionItemId,
      targetFormatId: format.id,
      compositionName: row.hook,
      descriptImportPath: "precise-cut",
    })
    .returning({ id: repurposeTriggers.id });

  await enqueue("clip-idea-precise-cut", {
    clipIdeaId: args.clipIdeaId,
    triggerId: trigger.id,
    derivativeItemId: productionItemId,
    applyLayoutPack: args.applyLayoutPack,
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
  const format = await loadPromotedClipFormat(brand);

  // Re-fetch the pillar — `loadAndGuardClipIdea` only returns mediaS3Key /
  // descriptProjectId, but the warm path also needs descriptCompositionId
  // and descriptProjectUrl, and we may need to write back to the pillar.
  const [pillar] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      descriptProjectId: productionItems.descriptProjectId,
      descriptProjectUrl: productionItems.descriptProjectUrl,
      descriptCompositionId: productionItems.descriptCompositionId,
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

  if (pillar.descriptProjectId && pillar.descriptCompositionId) {
    mode = "warm";
    const dup = await duplicateDescriptComposition({
      projectId: pillar.descriptProjectId,
      sourceCompositionId: pillar.descriptCompositionId,
      newCompositionName: row.hook,
    });
    jobId = dup.jobId;
    projectId = dup.projectId;
    projectUrl = pillar.descriptProjectUrl ?? dup.projectUrl ?? null;
    descriptPrompt = dup.prompt;
  } else if (pillar.mediaS3Key) {
    mode = "cold";
    const presigned = await getPresignedGetUrl(pillar.mediaS3Key, 3600);
    const projectName = pillar.title ?? `Pillar ${pillar.id.slice(0, 8)}`;
    const importRes = await createDescriptProjectFromUrl({
      projectName,
      mediaUrl: presigned,
    });
    jobId = importRes.job_id;
    projectId = importRes.project_id;
    projectUrl = importRes.project_url;
    descriptPrompt = null;
    pillarItemIdToStamp = pillar.id;
    importMode = true;

    // Stamp the pillar with project_id + project_url + descriptImportedAt
    // immediately. compositionId follows via the poll task. Future clips on
    // this pillar will see descriptCompositionId set and take the warm path.
    await db
      .update(productionItems)
      .set({
        descriptProjectId: projectId,
        descriptProjectUrl: projectUrl,
        descriptImportedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, pillar.id));
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
      producerUserId: args.actorUserId,
      editorUserId: args.actorUserId,
      descriptProjectId: projectId,
      descriptProjectUrl: projectUrl,
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
      descriptImportPath: "full-video",
    })
    .returning({ id: repurposeTriggers.id });

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
  };
}
