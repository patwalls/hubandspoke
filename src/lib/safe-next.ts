/**
 * Where to land after logging in. Middleware sends a logged-out visitor to
 * `/login?next=<the page they asked for>` so a link from an email (the
 * morning email's Approve, a post link) still lands on that page after the
 * login, not on the home page.
 *
 * Only same-site paths pass: anything else (another host, `//evil.com`,
 * `/\evil.com`, a `javascript:` URL) falls back to "/", so the login page
 * can't be used to bounce someone to another site.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
