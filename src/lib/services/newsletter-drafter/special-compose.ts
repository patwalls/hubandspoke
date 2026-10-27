// Pure helpers that put the stored Special into a newsletter body. No
// imports, so the page (client) and the HubSpot push (worker) share them.

export const SPECIAL_MARKER = "[[THE_SPECIAL]]";

/**
 * The Special as Markdown: the copy, plus a CTA link to the landing page when
 * the copy doesn't already carry it. Exported for tests.
 */
export function composeSpecialBlock(copy: string, landingUrl: string | null): string {
  const text = copy.trim();
  if (!landingUrl || text.includes(landingUrl)) return text;
  return `${text}\n\n**[Check it out HERE](${landingUrl})**`;
}

/** Swap SPECIAL_MARKER in the agent's body for the Special block. Exported for tests. */
export function composeBody(bodyMarkdown: string, special: { copy: string | null; landingUrl: string | null } | null): string {
  if (!special?.copy || !bodyMarkdown.includes(SPECIAL_MARKER)) return bodyMarkdown;
  return bodyMarkdown.replace(SPECIAL_MARKER, composeSpecialBlock(special.copy, special.landingUrl));
}

/**
 * The ad's main call-to-action link: the last line that is only a link (it
 * renders as the button), else the last Markdown link, else the last bare
 * URL. Structural, not content: it reads URL shapes only. Exported for tests.
 */
export function adLink(markdown: string): string | null {
  const lines = markdown.split("\n").map((l) => l.trim());
  const only = lines.map((l) => /^(?:\*\*|__)?\[[^\]]*\]\((\S+?)\)(?:\*\*|__)?$/.exec(l)?.[1]).filter(Boolean);
  if (only.length) return only[only.length - 1]!;
  const md = [...markdown.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map((m) => m[1]);
  if (md.length) return md[md.length - 1];
  const bare = [...markdown.matchAll(/https?:\/\/[^\s)<>\]]+/g)].map((m) => m[0]);
  return bare.length ? bare[bare.length - 1] : null;
}

/** The ad with its main link swapped for `url` (every copy of it), or a CTA line added when it has none. Exported for tests. */
export function withAdLink(markdown: string, url: string): string {
  const old = adLink(markdown);
  return old ? markdown.split(old).join(url) : composeSpecialBlock(markdown, url);
}
