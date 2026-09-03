/**
 * Which Descript workspace owns a NEWLY created clip project, keyed by who
 * clicked Create.
 *
 * Default is the shared HubSpot workspace (`descript_account = 'hubspot'` →
 * `DESCRIPT_API_TOKEN_HUBSPOT`, the 2026-08-10 dual-account setup). Pat's
 * promotions are the exception: his personal Descript login is not a member
 * of the HubSpot workspace, so projects created there are unopenable for
 * him — his clips go to his legacy account instead (`NULL` →
 * `DESCRIPT_API_TOKEN`).
 *
 * Only consulted at project-creation time. Every later operation (polling,
 * layout pack, publish) reads the `descript_account` stamped on the row, so
 * the project never migrates between workspaces mid-lifecycle.
 */
const LEGACY_DESCRIPT_ACCOUNT_EMAILS = new Set(["patrickswalls@gmail.com"]);

export function resolveDescriptAccountForActor(
  email: string | null,
): "hubspot" | null {
  if (email && LEGACY_DESCRIPT_ACCOUNT_EMAILS.has(email.toLowerCase())) {
    return null;
  }
  return "hubspot";
}

/**
 * Interpret the `descriptAccount` field of a task payload. `null` is a
 * MEANINGFUL value (the legacy account) — only a genuinely absent field
 * (payloads enqueued before the field existed) falls back to "hubspot",
 * the behavior those jobs were created under. Never use `??` for this:
 * it collapses null into the fallback and silently reroutes legacy-account
 * jobs to HubSpot (shipped bug, 2026-09-03).
 */
export function descriptAccountFromPayload(
  value: string | null | undefined,
): string | null {
  return value === undefined ? "hubspot" : value;
}
