/**
 * Extract a Canva Brand Template ID from a format's `instructions` (Skill).
 *
 * Two URL shapes can appear in the Skill:
 *
 *   1. Brand template URL — what the autofill API actually wants:
 *      https://www.canva.com/brand/brand-templates/EAHJfsp7GaE
 *      The ID begins with "EA" (or other Brand-Template prefixes Canva
 *      may issue — we accept any prefix and rely on the API to reject
 *      bad IDs).
 *
 *   2. Design URL — the underlying design that was saved as a brand
 *      template:
 *      https://www.canva.com/design/DAGytttEXSY/...
 *      The DA-prefixed ID is NOT what `/v1/autofills` accepts. We keep
 *      back-compat parsing for it so older formats whose Skill only has a
 *      design URL surface a clear "wrong ID type" error at API time
 *      instead of silently being ignored — but the brand-template URL
 *      always wins if both are present.
 *
 * Returns null if neither pattern is found.
 */
export function extractCanvaTemplateId(
  skill: string | null | undefined,
): string | null {
  if (!skill) return null;
  const brandMatch = skill.match(
    /canva\.com\/brand\/brand-templates\/([A-Za-z0-9_-]+)/,
  );
  if (brandMatch) return brandMatch[1];
  const designMatch = skill.match(/canva\.com\/design\/(DA[A-Za-z0-9_-]+)/);
  return designMatch ? designMatch[1] : null;
}
