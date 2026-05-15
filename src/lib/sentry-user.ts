import type { Session } from "next-auth";
import * as Sentry from "@sentry/nextjs";

/**
 * Stamp the authenticated user onto Sentry's scope so any error emitted
 * during this request/render carries `{ id, email, username }` and shows
 * up in the "Affected users" panel. Each request gets its own isolation
 * scope from `@sentry/nextjs`, so there's no cross-user leak.
 *
 * Server-side: call from `requireSession` / `requireAdmin` (covers API
 * routes) and from authed layouts after `await auth()` (covers RSC page
 * renders). Client-side: render `<SentryUser />` in the authed layout
 * tree so browser-side exceptions land with the same context.
 *
 * See docs/automation.md → Error tracking.
 */
export function setSentrySessionUser(session: Session): void {
  if (!session.user) return;
  Sentry.setUser({
    id: (session.user.id as string | undefined) ?? undefined,
    email: session.user.email ?? undefined,
    username: session.user.name ?? undefined,
  });
}
