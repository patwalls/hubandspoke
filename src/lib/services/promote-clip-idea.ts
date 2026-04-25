import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  formats,
  productionItems,
  repurposeTriggers,
  users,
} from "@/lib/db/schema";
import { invokeDescriptAgent } from "@/lib/descript";
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

const PROMOTED_CLIP_FORMAT = "Repackage section with hook";

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

export async function assignClipIdea(args: {
  clipIdeaId: string;
  editorUserId: string;
  decidedByUserId: string;
}): Promise<AssignClipIdeaResult> {
  const row = await loadAndGuardClipIdea(args.clipIdeaId);
  const editor = await loadEditor(args.editorUserId);
  const body = buildContentBody(row);
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);

  // Flip the pre-created production_item from Idea → Assigned and stamp the
  // chosen editor. Producer flips to the actor who's promoting the idea so
  // ownership matches who decided. Title/hook/contentBody re-stamped in case
  // they changed since generation. The partial unique index on
  // source_clip_idea_id stays honored — we're updating, not inserting.
  await db
    .update(productionItems)
    .set({
      status: "Assigned",
      title: row.hook,
      hook: row.hook,
      contentBody: body,
      producerUserId: args.decidedByUserId,
      editorUserId: args.editorUserId,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, productionItemId));

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

async function ensurePromotedClipFormat(brand: string): Promise<string> {
  const [existing] = await db
    .select({ id: formats.id })
    .from(formats)
    .where(
      and(eq(formats.name, PROMOTED_CLIP_FORMAT), eq(formats.brand, brand)),
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
    .where(eq(formats.name, PROMOTED_CLIP_FORMAT))
    .limit(1);
  if (byName) return byName.id;

  const [created] = await db
    .insert(formats)
    .values({ name: PROMOTED_CLIP_FORMAT, brand })
    .returning({ id: formats.id });
  if (!created) {
    throw new Error(
      `Failed to create format row "${PROMOTED_CLIP_FORMAT}" for brand "${brand}"`,
    );
  }
  return created.id;
}

function buildDescriptPrompt(args: {
  hook: string;
  startSec: number;
  endSec: number;
}): string {
  const duration = Math.max(0, Math.round(args.endSec - args.startSec));
  const start = formatTimestamp(args.startSec);
  const end = formatTimestamp(args.endSec);
  const safeHook = args.hook.replace(/"/g, '\\"');
  return [
    "You are producing a short-form vertical clip. Follow these instructions exactly and do not deviate.",
    "",
    `1. In the main composition, locate the transcript segment between ${start} and ${end} (duration ≈ ${duration}s). The time range is non-negotiable.`,
    `2. Create a NEW composition named "${safeHook}" containing only that segment. Do not include footage outside this range. The start must land on the first spoken word inside the range; the end must land on the last spoken word inside the range.`,
    "3. Set the new composition to a vertical 9:16 aspect ratio (1080×1920) sized for TikTok / Reels / Shorts. If the source is 16:9, center-crop or reframe so the speaker stays on screen.",
    "4. Inside the new composition, mark filler words (\"um\", \"uh\", \"like\" when used as filler, \"you know\", \"I mean\", false starts, repeated words, and long silences > 400ms) as IGNORED — use Descript's ignore / strike-through feature so the words remain visible in the script crossed out but are skipped during playback. DO NOT DELETE these words; they must stay in the transcript, just ignored.",
    "5. Do not add transitions, effects, music, captions, or title cards. Do not re-order anything. Do not rewrite the transcript.",
    "",
    "If any instruction conflicts with another, prioritize #1 (exact time range) and #2 (no footage outside the range). In the agent response, report what you did for each numbered item.",
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
      return createClipIdeaInDescriptPreciseCut(args);
    }
    throw new ClipIdeaSourceMissingDescriptProjectError();
  }
  const brand = row.sourceBrand ?? "starter-story";
  const editor = await loadEditor(args.actorUserId);
  const body = buildContentBody(row);
  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);

  // repurpose_triggers.target_format_id is NOT NULL. Ensure a bare
  // "Repackage section with hook" format row exists for this brand and
  // reuse it across every clip-idea promotion — same name we stamp on
  // productionItems.format. Matches the existing assign flow's string
  // value, now backed by an actual row the FK can reference.
  const formatId = await ensurePromotedClipFormat(brand);

  const prompt = buildDescriptPrompt({
    hook: row.hook,
    startSec,
    endSec,
  });
  const agent = await invokeDescriptAgent({
    projectId: row.descriptProjectId,
    prompt,
  });

  await db
    .update(productionItems)
    .set({
      status: "Assigned",
      title: row.hook,
      hook: row.hook,
      contentBody: body,
      producerUserId: args.actorUserId,
      editorUserId: args.actorUserId,
      descriptProjectId: row.descriptProjectId,
      descriptProjectUrl: agent.projectUrl,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, productionItemId));

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: row.sourceProductionItemId,
      targetFormatId: formatId,
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
}): Promise<CreateClipIdeaInDescriptPreciseCutResult> {
  const row = await loadAndGuardClipIdea(args.clipIdeaId);
  if (!row.mediaS3Key) {
    throw new ClipIdeaSourceMissingMediaError();
  }
  const brand = row.sourceBrand ?? "starter-story";
  const editor = await loadEditor(args.actorUserId);
  const body = buildContentBody(row);
  const productionItemId = await loadClipProductionItemId(args.clipIdeaId);

  const formatId = await ensurePromotedClipFormat(brand);

  await db
    .update(productionItems)
    .set({
      status: "Assigned",
      title: row.hook,
      hook: row.hook,
      contentBody: body,
      producerUserId: args.actorUserId,
      editorUserId: args.actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(productionItems.id, productionItemId));

  const [trigger] = await db
    .insert(repurposeTriggers)
    .values({
      productionItemId: row.sourceProductionItemId,
      targetFormatId: formatId,
      compositionName: row.hook,
      descriptImportPath: "precise-cut",
    })
    .returning({ id: repurposeTriggers.id });

  await enqueue("clip-idea-precise-cut", {
    clipIdeaId: args.clipIdeaId,
    triggerId: trigger.id,
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
