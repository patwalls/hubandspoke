import { and, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { usageEvents } from "@/lib/db/schema";
import { USED_SCREEN_DAYS } from "./index";

/**
 * The screens (and marks) this person opened in the last `USED_SCREEN_DAYS`
 * days, for the What's new pop-up's `usersOf` check. One indexed range scan
 * on (user_id, created_at); only runs when a card that could pop up names
 * screens (`needsOpenedScreens`). Fail-open: on error the caller shows every
 * card, as before.
 */
export async function getOpenedScreens(userId: string, now: Date = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - USED_SCREEN_DAYS * 86_400_000);
  const rows = await db
    .selectDistinct({ screen: usageEvents.screen })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), gt(usageEvents.createdAt, since)));
  return rows.map((r) => r.screen);
}
