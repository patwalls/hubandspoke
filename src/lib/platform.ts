// Long-form YouTube pillars stay Notion-authoritative: editors still work
// their production process inside the source Notion database. Everything else
// (YouTube Shorts, YouTube Community, IG, LinkedIn, Twitter, etc.) is owned by
// Hub & Spoke — don't pull updates from Notion, don't push edits back.
const NOTION_AUTHORITATIVE_PLATFORMS = new Set([
  "YouTube",
  "YouTube (SS)",
  "YouTube (SS Build)",
]);

export function isNotionAuthoritative(
  platform: string[] | null | undefined
): boolean {
  if (!platform?.length) return false;
  return platform.some((p) => NOTION_AUTHORITATIVE_PLATFORMS.has(p));
}
