/** Prefix a task puts on an error that means "blocked, needs human action"
 *  (e.g. `descript-derivative-create`'s `blocked:needs_transcript:`). The
 *  status route reads it off `last_error` and the UI shows the reason, so a
 *  blocked job is not an incident: it must not page Sentry (HUBANDSPOKE-3E). */
export const BLOCKED_ERROR_PREFIX = "blocked:";

export function isBlockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.startsWith(BLOCKED_ERROR_PREFIX);
}
