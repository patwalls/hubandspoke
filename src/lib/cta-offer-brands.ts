// Client-safe constants for the per-format CTA offer path
// (src/lib/services/cta-offer.ts). Kept DB-free so the format page and brand
// settings UI can gate on them.

export const CTA_OFFER_BRANDS: ReadonlySet<string> = new Set(["matg"]);

/** True when `brand` uses the per-format offer path instead of Starter
 *  Story's tracked-CTA logic. Every branch added for this feature is gated
 *  on this — Starter Story and all other brands never reach it. */
export function usesCtaOffer(brand: string | null | undefined): boolean {
  return !!brand && CTA_OFFER_BRANDS.has(brand);
}

export const CTA_STRATEGIES = ["pillar_offer", "pillar_video", "fixed"] as const;
export type CtaStrategy = (typeof CTA_STRATEGIES)[number];

export function isCtaStrategy(v: unknown): v is CtaStrategy {
  return typeof v === "string" && (CTA_STRATEGIES as readonly string[]).includes(v);
}
