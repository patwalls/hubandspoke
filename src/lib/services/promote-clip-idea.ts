import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, productionItems, users } from "@/lib/db/schema";

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

function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; constraint_name?: string; message?: string };
  if (e.code !== "23505") return false;
  if (e.constraint_name === constraintName) return true;
  return typeof e.message === "string" && e.message.includes(constraintName);
}

export async function assignClipIdea(args: {
  clipIdeaId: string;
  editorUserId: string;
  decidedByUserId: string;
}): Promise<AssignClipIdeaResult> {
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
    })
    .from(clipIdeas)
    .leftJoin(
      productionItems,
      eq(productionItems.id, clipIdeas.sourceProductionItemId),
    )
    .where(eq(clipIdeas.id, args.clipIdeaId))
    .limit(1);

  if (!row) throw new ClipIdeaNotFoundError();
  if (row.status === "killed" || row.status === "accepted" || row.status === "assigned") {
    throw new ClipIdeaAlreadyDecidedError(row.status);
  }

  const [editor] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, args.editorUserId))
    .limit(1);

  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);
  const duration = Math.max(0, Math.round(endSec - startSec));
  const timestampRange = `${formatTimestamp(startSec)}–${formatTimestamp(endSec)} (${duration}s)`;
  const body = [
    `Source: ${row.sourceTitle ?? "(untitled)"}`,
    `Timestamp: ${timestampRange}`,
    "",
    `Angle: ${row.angle}`,
    "",
    `Why: ${row.rationale}`,
  ].join("\n");

  // Create the real production_items row. sourceType='clip' bypasses the
  // uniq(pillar, format) index, which is scoped to 'original' — many clips
  // per pillar+format is the whole point. The partial uniq index on
  // source_clip_idea_id is the replacement guarantee: one production item
  // per clip idea, enforced at the DB. Default producer = the admin who
  // assigned; editor = the assignee. Default platform = YouTube Shorts,
  // editor can swap on the detail page.
  let created: { id: string } | undefined;
  try {
    const rows = await db
      .insert(productionItems)
      .values({
        title: row.hook,
        status: "Assigned",
        platform: ["YouTube Shorts"],
        format: "Repackage section with hook",
        brand: row.sourceBrand ?? "starter-story",
        contentBody: body,
        pillarContentItemId: row.sourceProductionItemId,
        sourceType: "clip",
        sourceClipIdeaId: args.clipIdeaId,
        producerUserId: args.decidedByUserId,
        editorUserId: args.editorUserId,
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
      acceptedProductionItemId: created.id,
      decidedAt: new Date(),
      decidedByUserId: args.decidedByUserId,
    })
    .where(eq(clipIdeas.id, args.clipIdeaId));

  return {
    sourceProductionItemId: row.sourceProductionItemId,
    sourceTitle: row.sourceTitle,
    sourceBrand: row.sourceBrand ?? "starter-story",
    hook: row.hook,
    editorName: editor?.name ?? null,
    editorEmail: editor?.email ?? null,
    newProductionItemId: created.id,
  };
}
