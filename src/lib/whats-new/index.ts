import { isFeatureEnabled } from "@/lib/feature-flags";
import { WHATS_NEW, type WhatsNewEntry } from "./entries";

export type { WhatsNewEntry } from "./entries";

export interface WhatsNewViewer {
  email?: string | null;
  role?: string | null;
}

/** Most cards a returning user is shown at once — older unseen ones stay in the full list. */
export const MAX_POPUP = 5;

/** Every card this viewer is allowed to see, newest first. */
export function visibleTo(
  viewer: WhatsNewViewer,
  entries: WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  return entries.filter((e) => {
    if (e.audience?.adminOnly && viewer.role !== "admin") return false;
    if (e.audience?.flag && !isFeatureEnabled(e.audience.flag, viewer)) return false;
    return true;
  });
}

/**
 * The cards to pop up: visible, shipped after the viewer last dismissed the
 * pop-up — or, if they never have, after their account was created, so a new
 * teammate isn't greeted with months of history.
 */
export function unseenFor(
  viewer: WhatsNewViewer,
  seenAt: Date | null,
  createdAt: Date,
  entries: WhatsNewEntry[] = WHATS_NEW,
): WhatsNewEntry[] {
  const since = (seenAt ?? createdAt).getTime();
  return visibleTo(viewer, entries)
    .filter((e) => new Date(e.shippedAt).getTime() > since)
    .slice(0, MAX_POPUP);
}

/** Fill `[brand]` in a card's link with the viewer's brand. */
export function hrefFor(entry: WhatsNewEntry, brand: string): string | undefined {
  return entry.href?.replace("[brand]", brand);
}
