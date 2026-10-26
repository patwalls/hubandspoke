// A push to the email tool (hubspot-newsletter-create-draft,
// beehiiv-newsletter-create-draft) marks the draft "pending" and runs once on
// the worker (maxAttempts 1: a retry after a create that succeeded would make
// a second email). If the worker dies mid-push, nothing ever clears
// "pending" — the editor would spin and keep the button disabled forever. A
// push takes seconds (a few HTTP calls with 20s timeouts), so one pending far
// longer than that is dead: shown as failed, and the push route takes a
// retry. Pure.

/** Longer than any push can take. */
export const PUSH_STALE_MS = 10 * 60 * 1000;

export function stalePush(status: string | null, updatedAt: Date, now = Date.now()): boolean {
  return status === "pending" && now - updatedAt.getTime() > PUSH_STALE_MS;
}

/** The push status and error to show: a stale "pending" reads as failed, with what to do. */
export function pushView(status: string | null, error: string | null, updatedAt: Date, now: number, tool: "HubSpot" | "beehiiv"): { status: string | null; error: string | null } {
  if (!stalePush(status, updatedAt, now)) return { status, error };
  return { status: "failed", error: `The push to ${tool} didn't finish (the worker restarted mid-push). Check ${tool} for a half-made copy and delete it, then try again.` };
}
