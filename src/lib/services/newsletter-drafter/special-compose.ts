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
