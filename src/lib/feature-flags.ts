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
 */

interface FlagDefinition {
  /** Emails that always have the flag. Compared case-insensitively. */
  emails: readonly string[];
  /** Env var holding extra comma-separated emails. */
  envVar: string;
}

const FLAGS = {
  /**
   * In-app clip editor: the queue's clip modal becomes a transcript-driven
   * editor that renders the final clip on our own worker instead of sending
   * it to Descript. See docs/features.md → "Clip editor".
   */
  clipEditor: {
    emails: ["patrickswalls@gmail.com"],
    envVar: "FEATURE_CLIP_EDITOR_EMAILS",
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
  const email = user?.email ? normalize(user.email) : "";
  if (!email) return false;
  const def: FlagDefinition = FLAGS[flag];
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
