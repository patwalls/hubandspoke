// A newsletter edition's queue item follows the edition through the same
// pipeline stages every format uses (both brands have them):
//   Idea → Assigned (Draft clicked) → Review (draft written) → Ready To Publish
//   (pushed to HubSpot / beehiiv as an unsent draft) → Published (later: send
//   detection). Only ever moves FORWARD, and never touches an item someone set
//   by hand to On Hold / Scheduled / Published / Killed (or any custom stage).

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts, productionItems } from "@/lib/db/schema";

export const NEWSLETTER_STAGES = ["Idea", "Assigned", "Review", "Ready To Publish"] as const;
export type NewsletterStage = (typeof NEWSLETTER_STAGES)[number];

/** Stages an item may be moved FROM to reach `to` (the ones before it). Pure; exported for tests. */
export function stagesBefore(to: NewsletterStage): NewsletterStage[] {
  return NEWSLETTER_STAGES.slice(0, NEWSLETTER_STAGES.indexOf(to)) as NewsletterStage[];
}

/** Move the edition's queue item forward to `to`. No-op without a linked item, or when it's already past it. */
export async function advanceNewsletterItem(newsletterDraftId: string, to: NewsletterStage): Promise<void> {
  const [d] = await db
    .select({ itemId: newsletterDrafts.productionItemId })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.id, newsletterDraftId))
    .limit(1);
  if (!d?.itemId) return;
  await db
    .update(productionItems)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(productionItems.id, d.itemId), inArray(productionItems.status, stagesBefore(to))));
}
