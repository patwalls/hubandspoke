/**
 * All NEW Descript projects go to the shared HubSpot workspace
 * (`descript_account = 'hubspot'` → `DESCRIPT_API_TOKEN_HUBSPOT`). Between
 * 2026-09-03 v837 and v839 Pat's promotions routed to his legacy account
 * (his login lacked HubSpot workspace access); that access now exists, so
 * the per-actor split is gone. Existing rows keep the account they were
 * born under: every later operation (polling, layout pack, publish) reads
 * the `descript_account` stamped on the row — `NULL` = legacy account
 * (`DESCRIPT_API_TOKEN`) — so a project never migrates workspaces
 * mid-lifecycle.
 */
export const NEW_DESCRIPT_PROJECT_ACCOUNT = "hubspot";

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
