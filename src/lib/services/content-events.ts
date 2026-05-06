import { db } from "@/lib/db";
import { contentEvents, type ContentEventPayload } from "@/lib/db/schema";

type ToolActionPayload = Extract<ContentEventPayload, { type: "tool_action" }>;

export interface RecordToolActionArgs {
  contentItemId: string;
  /** Actor who triggered the underlying action. Null when the worker
   *  can't resolve a user (renders as "Someone …" in the feed). */
  userId: string | null;
  tool: ToolActionPayload["tool"];
  action: ToolActionPayload["action"];
  status: ToolActionPayload["status"];
  label: ToolActionPayload["label"];
  url?: ToolActionPayload["url"];
  meta?: ToolActionPayload["meta"];
}

export async function recordToolAction(
  args: RecordToolActionArgs,
): Promise<void> {
  const payload: ToolActionPayload = {
    type: "tool_action",
    tool: args.tool,
    action: args.action,
    status: args.status,
    label: args.label,
    url: args.url ?? null,
    ...(args.meta ? { meta: args.meta } : {}),
  };
  await db.insert(contentEvents).values({
    contentItemId: args.contentItemId,
    userId: args.userId,
    eventType: "tool_action",
    payload,
  });
}
