import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  formats,
  productionItems,
  users,
} from "@/lib/db/schema";
import { createNotionRepurposeTask } from "@/lib/services/notion-tasks";
import { formatTimestamp } from "@/lib/utils/vtt";

export class PromoteClipIdeaError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "idea_not_found"
      | "idea_not_suggested"
      | "pillar_not_found"
      | "format_not_found"
      | "editor_not_found"
      | "editor_no_notion_id"
      | "notion_create_failed"
  ) {
    super(message);
    this.name = "PromoteClipIdeaError";
  }
}

export interface PromoteArgs {
  clipIdeaId: string;
  targetFormatName: string;
  editorUserId: string;
  decidedByUserId: string;
}

export interface PromoteResult {
  clipIdeaId: string;
  notionPageId: string;
  notionPageUrl: string;
  targetFormat: string;
  editorUserId: string;
}

/**
 * Accept a clip idea: create a Notion A-Record already assigned to the given
 * freelancer, and mark the clip_ideas row as accepted.
 *
 * The productionItems row does NOT get inserted here. The hourly Notion sync
 * (src/lib/services/notion-sync.ts) will pull the new page in — matching the
 * existing threshold-monitor → Notion task → sync flow. The acceptedNotionPageId
 * is the canonical handle; callers can join to production_items by notion_id
 * once sync catches up.
 */
export async function promoteClipIdea(args: PromoteArgs): Promise<PromoteResult> {
  const [idea] = await db
    .select()
    .from(clipIdeas)
    .where(eq(clipIdeas.id, args.clipIdeaId))
    .limit(1);

  if (!idea) {
    throw new PromoteClipIdeaError(
      `clip idea ${args.clipIdeaId} not found`,
      "idea_not_found"
    );
  }
  if (idea.status !== "suggested") {
    throw new PromoteClipIdeaError(
      `clip idea ${args.clipIdeaId} is ${idea.status}, expected 'suggested'`,
      "idea_not_suggested"
    );
  }

  const [pillar] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      notionId: productionItems.notionId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, idea.sourceProductionItemId))
    .limit(1);

  if (!pillar) {
    throw new PromoteClipIdeaError(
      `pillar ${idea.sourceProductionItemId} not found`,
      "pillar_not_found"
    );
  }

  const [format] = await db
    .select({
      name: formats.name,
      notionPageId: formats.notionPageId,
      channels: formats.channels,
    })
    .from(formats)
    .where(sql`lower(${formats.name}) = lower(${args.targetFormatName})`)
    .limit(1);

  if (!format) {
    throw new PromoteClipIdeaError(
      `format "${args.targetFormatName}" not found`,
      "format_not_found"
    );
  }

  const [editor] = await db
    .select({
      id: users.id,
      name: users.name,
      notionUserId: users.notionUserId,
    })
    .from(users)
    .where(eq(users.id, args.editorUserId))
    .limit(1);

  if (!editor) {
    throw new PromoteClipIdeaError(
      `user ${args.editorUserId} not found`,
      "editor_not_found"
    );
  }
  if (!editor.notionUserId) {
    throw new PromoteClipIdeaError(
      `${editor.name || editor.id} has no notion_user_id on their profile — can't assign in Notion`,
      "editor_no_notion_id"
    );
  }

  const channel = format.channels?.[0];
  const startMMSS = formatTimestamp(Number(idea.startSec));
  const endMMSS = formatTimestamp(Number(idea.endSec));
  const guidanceMarkdown = [
    `**Hook:** "${idea.hook}"`,
    ``,
    `**Angle:** ${idea.angle}`,
    ``,
    `**Why this clip:** ${idea.rationale}`,
    ``,
    `**Source clip:** ${startMMSS}–${endMMSS} of the pillar video`,
  ].join("\n");

  const notionResult = await createNotionRepurposeTask({
    pillarContentTitle: pillar.title || "(untitled)",
    pillarContentNotionId: pillar.notionId || undefined,
    targetFormatName: format.name,
    targetFormatNotionPageId: format.notionPageId || undefined,
    channel,
    editorNotionUserId: editor.notionUserId,
    guidanceMarkdown,
  });

  if (!notionResult.success || !notionResult.notionPageId) {
    throw new PromoteClipIdeaError(
      `Notion task creation failed: ${notionResult.error ?? "unknown error"}`,
      "notion_create_failed"
    );
  }

  await db
    .update(clipIdeas)
    .set({
      status: "accepted",
      acceptedNotionPageId: notionResult.notionPageId,
      acceptedNotionPageUrl: notionResult.notionPageUrl || null,
      acceptedTargetFormat: format.name,
      acceptedEditorUserId: editor.id,
      decidedAt: new Date(),
      decidedByUserId: args.decidedByUserId,
    })
    .where(eq(clipIdeas.id, args.clipIdeaId));

  return {
    clipIdeaId: args.clipIdeaId,
    notionPageId: notionResult.notionPageId,
    notionPageUrl: notionResult.notionPageUrl || "",
    targetFormat: format.name,
    editorUserId: editor.id,
  };
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
}
