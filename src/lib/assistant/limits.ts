import { and, count, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantMessages } from "@/lib/db/schema";

/** Questions per person per rolling 24 hours — each one is a paid model call. */
export const ASSISTANT_DAILY_LIMIT = 40;

export async function questionsInLastDay(userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ n: count() })
    .from(assistantMessages)
    .where(and(eq(assistantMessages.userId, userId), gte(assistantMessages.createdAt, since)));
  return Number(row?.n ?? 0);
}
