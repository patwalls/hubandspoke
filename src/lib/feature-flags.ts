/**
 * Per-user feature flags.
 *
 * A flag is a named allowlist of user emails. There is deliberately no
 * percentage rollout, no DB table, and no admin UI: a flag here gates a
 * feature that is still being built, so the only question it answers is "is
 * this one of the few people dogfooding it?". When a feature graduates, delete
 * its flag and the branches that read it — don't leave it on at 100%.
 *
 * The check is SERVER-AUTHORITATIVE. Every API route behind a flag must call
 * `requireFeature` (src/lib/auth-guards.ts) — hiding the UI is not the gate.
 * Client components learn which flags are on from `GET /api/feature-flags`
 * (see `useFeatureFlags`), which only ever returns booleans, never the
 * allowlist.
 *
 * To add a flag: add a row to FLAGS. To widen one without a deploy (e.g. to
 * let the local e2e user through), set `FEATURE_<NAME>_EMAILS` to a
 * comma-separated list — it EXTENDS the hardcoded allowlist, it never replaces
 * it, so an unset/typo'd env var can only ever make a flag narrower than you
 * meant, not wider.
 *
 * Set `everyone: true` to turn a flag on for every signed-in user, including
 * accounts created later. Signed-out / email-less users still get `false`.
 */

export interface FlagDefinition {
  /** Emails that always have the flag. Compared case-insensitively. */
  emails: readonly string[];
  /** Env var holding extra comma-separated emails. */
  envVar: string;
  /** On for every signed-in user, regardless of `emails` / `envVar`. */
  everyone?: boolean;
}

const FLAGS = {
  /**
   * In-app clip editor: the queue's clip modal becomes a transcript-driven
   * editor that renders the final clip on our own worker instead of sending
   * it to Descript. See docs/features.md → "Clip editor".
   */
  clipEditor: {
    emails: ["patrickswalls@gmail.com", "sam@starterstory.com", "timjohn2002@gmail.com"],
    envVar: "FEATURE_CLIP_EDITOR_EMAILS",
    // Rolled out to every account (2026-10-07). The allowlist above is kept
    // only so flipping this back off restores the original dogfooders.
    everyone: true,
  },
  /**
   * In-app design editor: the Repurposed queue's modal becomes an AI-drafted,
   * Canva-like carousel editor for image-post formats (Instagram PLAYBOOK),
   * rendered on our own worker. See docs/features.md → "Design editor".
   */
  designEditor: {
    emails: ["patrickswalls@gmail.com", "sam@starterstory.com", "timjohn2002@gmail.com"],
    envVar: "FEATURE_DESIGN_EDITOR_EMAILS",
    // Rolled out to every account (2026-10-07). The allowlist above is kept
    // only so flipping this back off restores the original dogfooders.
    everyone: true,
  },
  /**
   * Newsletter drafter (Starter Story pilot): an agent reads the week's
   * published videos + recent starterstory.com case studies, drafts an issue
   * in a newsletter format's voice, and can push it to HubSpot portal 53 as
   * an unsent draft email. Drafts live in `newsletter_drafts`, never in
   * production_items. See docs/features.md → "Newsletter drafter".
   */
  newsletterDrafter: {
    emails: ["sam@starterstory.com", "patrickswalls@gmail.com", "gus@starterstory.com"],
    envVar: "FEATURE_NEWSLETTER_DRAFTER_EMAILS",
    // Rolled out to every account (2026-10-28) alongside brand permissions —
    // edits are now gated per brand, so the flag no longer needs to. The
    // allowlist above is kept only so flipping this back off restores the
    // original pilot users.
    everyone: true,
  },
  /**
   * Newsletter template admins: can unlock a locked newsletter template
   * (`locked` on the template — Futurepedia's beehiiv one) and change its
   * structure. Everyone else edits only section instructions there.
   */
  newsletterTemplateAdmin: {
    emails: ["sam@starterstory.com", "swalls@hubspot.com"],
    envVar: "FEATURE_NEWSLETTER_TEMPLATE_ADMIN_EMAILS",
  },
  /**
   * My Work morning email (my-day M4): one email each weekday with what's
   * waiting on you and the top five. See docs/features.md → "My Work".
   */
  myWorkDigest: {
    emails: ["patrickswalls@gmail.com", "e2e@local.test"],
    envVar: "FEATURE_MY_WORK_DIGEST_EMAILS",
    // Rolled out to every account (2026-10-26) after Pat read his own. The
    // allowlist above is kept only so flipping this back off restores Pat-only.
    // Each person can still turn it off on /my-work/email.
    everyone: true,
  },
  /**
   * Monday winners email ("what's working" M4): last week's posts that beat
   * their usual on every brand, with why, plus the formats that keep winning.
   * Pat-only while it's dogfooded. See docs/automation.md → `winners-email`.
   */
  winnersEmail: {
    emails: ["patrickswalls@gmail.com", "e2e@local.test"],
    envVar: "FEATURE_WINNERS_EMAIL_EMAILS",
  },
  /**
   * Cross-post picker: a target whose cross-posts always get handed to one
   * editor (e.g. the Shorts editor) is assigned to them, noted on its row,
   * instead of the dialog's "Assign to" pick. Pat-first 2026-11-18 07:25,
   * on for everyone the same day (2026-11-18): no errors, and the e2e spec
   * covers the dialog. The allowlist stays so flipping back restores it.
   * See docs/features.md → "Cross-post queue".
   */
  /**
   * Queue "Age" pill: the triage tabs default to ideas from the last 30 days
   * (thousands of untouched older clip ideas otherwise fill the counts), with
   * "Older than 30 days" / "Any age" one click away. Pat-first 2026-11-22;
   * client-only filter, so no route needs `requireFeature`. See
   * docs/features.md → "Queue age filter" and src/lib/queue-age.ts.
   */
  queueAge: {
    emails: ["patrickswalls@gmail.com", "e2e@local.test"],
    envVar: "FEATURE_QUEUE_AGE_EMAILS",
    // Graduated 2026-11-22 (no errors, one click back to "Any age").
    everyone: true,
  },
  /**
   * "Kill all N older ideas" on the queue's Older view: one server-side pass
   * kills a brand's (or one format's) Idea rows older than 30 days, with one
   * reason. Pat-first 2026-11-22 — it changes thousands of rows at once.
   * `POST /api/queue/clear-older` calls `requireFeature`. See
   * docs/features.md → "Queue age filter" and src/lib/queue-clear-older.ts.
   */
  queueClearOlder: {
    emails: ["patrickswalls@gmail.com", "e2e@local.test"],
    envVar: "FEATURE_QUEUE_CLEAR_OLDER_EMAILS",
  },
  /**
   * The queue's default "Last 30 days" view loads only recent Idea rows (plus
   * counts of the older ones) instead of every Idea row ever generated;
   * Older / Any age fetch the full report on demand. Pat-first 2026-11-23
   * (clip-ideas-backlog M3). Read by the queue page's SSR and the report API
   * (`?ideas=recent` is ignored without it). See docs/features.md → "Queue
   * age filter" and services/production-report.ts.
   */
  queueRecentOnly: {
    emails: ["patrickswalls@gmail.com", "e2e@local.test"],
    envVar: "FEATURE_QUEUE_RECENT_ONLY_EMAILS",
    // Graduated 2026-11-23: no errors since #235, and the default view shows
    // the same rows either way (the queue page was the top wait in sentry-tx,
    // p95 6 s). /api/warm now warms `recent-ideas` instead of `all`.
    everyone: true,
  },
  /**
   * Nav brand chips keep you on the same list page: switching brand from
   * In Production lands on the other brand's In Production (Content, Queue,
   * Scheduled, Publish, Formats, Accounts likewise) instead of its dashboard.
   * Pat-first 2026-11-23 — it changes where a daily click lands. Nav-only, so
   * no route needs `requireFeature`. See src/lib/brand-switch-href.ts.
   */
  brandSwitchKeepsSection: {
    emails: ["patrickswalls@gmail.com", "e2e@local.test"],
    envVar: "FEATURE_BRAND_SWITCH_KEEPS_SECTION_EMAILS",
    // Graduated 2026-11-23 (no errors; in 21 d of brand switches from a list
    // page, the next click went back to the same section 22 times vs 2 stays
    // on the dashboard). The allowlist stays so flipping back restores it.
    everyone: true,
  },
  crossPostUsualEditor: {
    emails: ["patrickswalls@gmail.com", "e2e@local.test"],
    envVar: "FEATURE_CROSS_POST_USUAL_EDITOR_EMAILS",
    everyone: true,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FeatureFlag = keyof typeof FLAGS;

export const FEATURE_FLAG_NAMES = Object.keys(FLAGS) as FeatureFlag[];

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** Minimal shape so callers can pass a next-auth session user directly. */
export interface FlagSubject {
  email?: string | null;
}

export function isFeatureEnabled(
  flag: FeatureFlag,
  user: FlagSubject | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabledFor(FLAGS[flag], user, env);
}

/** The check itself, against any definition — exported for tests. */
export function isEnabledFor(
  def: FlagDefinition,
  user: FlagSubject | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const email = user?.email ? normalize(user.email) : "";
  if (!email) return false;
  if (def.everyone) return true;
  if (def.emails.some((e) => normalize(e) === email)) return true;
  const extra = env[def.envVar];
  if (!extra) return false;
  return extra
    .split(",")
    .map(normalize)
    .filter(Boolean)
    .includes(email);
}

/** Every flag resolved for one user — the payload of `/api/feature-flags`. */
export function resolveFeatureFlags(
  user: FlagSubject | null | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<FeatureFlag, boolean> {
  const out = {} as Record<FeatureFlag, boolean>;
  for (const flag of FEATURE_FLAG_NAMES) {
    out[flag] = isFeatureEnabled(flag, user, env);
  }
  return out;
}
