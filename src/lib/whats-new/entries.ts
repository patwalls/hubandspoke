import type { FeatureFlag } from "@/lib/feature-flags";

/**
 * The "What's new" cards, NEWEST FIRST. Each one pops up once for every user
 * it applies to, on their next page load after it ships (see `unseenFor`).
 *
 * The product loop (`.claude/commands/build.md`) appends one per shipped
 * feature; humans can too. Rules for a card:
 * - `title` + `body` in plain words for the people using the app (editors,
 *   producers) — what they can do now and where. No jargon, no PR talk.
 * - `href` is where to try it; `[brand]` is filled with the viewer's default
 *   brand. `screen` is the `usage_events.screen` it lives on, so the loop can
 *   read whether it landed.
 * - `audience` narrows who sees it: a feature behind a flag must name the
 *   flag, an admin-only screen must say `adminOnly`.
 * - `id` is unique and never reused: `<YYYY-MM-DD>-<slug>`.
 */
export interface WhatsNewEntry {
  id: string;
  /** ISO timestamp it shipped; users who dismissed the pop-up after this don't see it. */
  shippedAt: string;
  kind: "feature" | "fix";
  title: string;
  body: string;
  href?: string;
  screen?: string;
  audience?: { flag?: FeatureFlag; adminOnly?: boolean };
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: "2026-10-21-whats-new",
    shippedAt: "2026-10-21T20:00:00Z",
    kind: "feature",
    title: "New improvements, every few days",
    body:
      "Hub & Spoke now ships improvements regularly, shaped by how the team actually uses it. " +
      "When something new lands you'll see it here once. The full list is under your name → What's new.",
  },
];
