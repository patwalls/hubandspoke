/**
 * Where a brand chip in the nav takes you.
 *
 * Without `keepSection` (the old behaviour) a switch lands on the new brand's
 * dashboard, except from Formats, which stays on Formats. With it (flag
 * `brandSwitchKeepsSection`), switching from one of a brand's list pages lands
 * on the same list page of the new brand: In Production stays In Production.
 * People who switched brand from a list page went straight back to that same
 * page on most switches, one click they repeated every time.
 *
 * Only the top-level list pages carry over. A post page or a format page
 * (`/x/content/<id>`) has no twin in the other brand, so it lands on the
 * dashboard as before; a queue tab (`/x/queue/<format>`) lands on the queue,
 * since the other brand may not have that format. "All" only has Content,
 * In Production and Queue.
 */

const KEPT_SECTIONS = new Set([
  "content",
  "production",
  "queue",
  "scheduled",
  "publish",
  "formats",
  "accounts",
]);

const ALL_SECTIONS = new Set(["content", "production", "queue"]);

export function brandSwitchHref(
  pathname: string,
  targetSlug: string,
  keepSection: boolean,
): string {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  const section = parts[1] ?? null;
  const rest = parts.slice(2);

  if (!keepSection) {
    if (targetSlug === "all") return "/all";
    return section === "formats" && rest.length === 0
      ? `/${targetSlug}/formats`
      : `/${targetSlug}`;
  }

  if (!section || !KEPT_SECTIONS.has(section)) return `/${targetSlug}`;
  // A detail page has no twin in another brand; a queue tab is format-specific.
  if (rest.length > 0 && section !== "queue") return `/${targetSlug}`;
  if (targetSlug === "all" && !ALL_SECTIONS.has(section)) return "/all";
  return `/${targetSlug}/${section}`;
}
