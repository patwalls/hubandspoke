// Client-safe constants for the per-format CTA offer path
// (src/lib/services/cta-offer.ts). Kept DB-free so the format page and brand
// settings UI can gate on them.

export const CTA_OFFER_BRANDS: ReadonlySet<string> = new Set(["matg", "my-first-million"]);

/** True when `brand` uses the per-format offer path instead of Starter
 *  Story's tracked-CTA logic. Every branch added for this feature is gated
 *  on this — Starter Story and all other brands never reach it. */
export function usesCtaOffer(brand: string | null | undefined): boolean {
  return !!brand && CTA_OFFER_BRANDS.has(brand);
}

// ── Brand short names ─────────────────────────────────────────────────────
// One short name per brand, used for BOTH its Rebrandly link prefix
// ("mfm-ideavault") and its utm_source ("mfm"), so the two can't disagree.
// A brand missing here falls back to its slug.
export const BRAND_SHORT_NAME: Readonly<Record<string, string>> = {
  matg: "matg",
  "my-first-million": "mfm",
};

export function brandShortName(brand: string): string {
  return BRAND_SHORT_NAME[brand] ?? brand;
}

// ── ManyChat DM keywords on Rebrandly (clickhubspot.com) ──────────────────
// Brands whose DM keywords are Rebrandly links "<short>-<keyword>" in the
// "Hub & Spoke Content" workspace (src/lib/services/rebrandly.ts) instead of
// Starter Story's go.starterstory.com pool. The keyword links themselves are
// the pool. Each post also gets its own link "<short>-p-<id>" that the keyword
// points at (the go→go chain Starter Story uses), so a post keeps its own
// destination + UTMs + click count after its keyword moves on.
export const REBRANDLY_DM_BRANDS: ReadonlySet<string> = new Set(["matg", "my-first-million"]);

export const REBRANDLY_DM_BASE_URL = "https://clickhubspot.com";

/** Kept for callers that show a brand's link prefix. */
export const DM_LINK_PREFIX_BY_BRAND: Readonly<Record<string, string>> = Object.fromEntries(
  Array.from(REBRANDLY_DM_BRANDS, (b) => [b, brandShortName(b)]),
);

export function usesRebrandlyDm(brand: string | null | undefined): boolean {
  return !!brand && REBRANDLY_DM_BRANDS.has(brand);
}

/** The per-post link's slashtag: "<short>-p-<first 8 hex of the item id>". */
export function perPostDmSlashtag(brand: string, itemId: string): string {
  return `${brandShortName(brand)}-p-${itemId.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
}

function isPerPostSlashtag(brand: string, slashtag: string): boolean {
  return slashtag.toLowerCase().startsWith(`${brandShortName(brand)}-p-`);
}

/** True when `slashtag` (e.g. "mfm-ideavault") is one of `brand`'s KEYWORD
 *  links — not another brand's, and not a per-post link. */
export function isBrandDmSlashtag(brand: string, slashtag: string): boolean {
  if (!usesRebrandlyDm(brand)) return false;
  const prefix = brandShortName(brand);
  const s = slashtag.toLowerCase();
  return s.startsWith(`${prefix}-`) && s.length > prefix.length + 1 && !isPerPostSlashtag(brand, s);
}

/**
 * The word people comment for an attached keyword. Rebrandly brands store the
 * slashtag ("mfm-ideavault" → "ideavault"); a leftover Starter Story slug on
 * one of their posts isn't theirs, so it gives null. Other brands' slugs are
 * the word itself.
 */
export function commentKeywordFor(brand: string | null | undefined, slug: string | null | undefined): string | null {
  if (!slug) return null;
  if (!usesRebrandlyDm(brand)) return slug;
  if (!isBrandDmSlashtag(brand!, slug)) return null;
  return slug.slice(brandShortName(brand!).length + 1);
}

export const CTA_STRATEGIES = ["pillar_offer", "pillar_video", "fixed"] as const;
export type CtaStrategy = (typeof CTA_STRATEGIES)[number];

export function isCtaStrategy(v: unknown): v is CtaStrategy {
  return typeof v === "string" && (CTA_STRATEGIES as readonly string[]).includes(v);
}

// ── CTA UTMs (every CTA_OFFER_BRANDS brand) ───────────────────────────────
// One fixed rule for every non–Starter Story brand — nothing to configure
// per brand. {{brand}} → the brand's short name, {{platform}} → the platform
// (x, linkedin, threads, youtube, instagram), {{cta_utm}} → the post's CTA
// UTM field (production_items.utm_campaign).

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type CtaUtmTemplate = Partial<Record<UtmKey, string>>;

export const OFFER_UTM_RULE: Readonly<CtaUtmTemplate> = {
  utm_medium: "email-media-newsletter",
  utm_source: "{{brand}}",
  utm_campaign: "owned",
  utm_content: "Social",
  utm_term: "{{platform}}",
  utm_id: "{{cta_utm}}",
};

export const UTM_PLACEHOLDERS = ["{{brand}}", "{{platform}}", "{{cta_utm}}"] as const;

// CTA channel → the platform name {{platform}} becomes.
const PLATFORM_BY_CHANNEL: Record<string, string> = { ytcommunity: "youtube" };

export function platformForChannel(channel: string): string {
  return PLATFORM_BY_CHANNEL[channel] ?? channel;
}

/**
 * Fills a UTM template for one post. A key whose value comes out blank (e.g.
 * `{{cta_utm}}` on a post without one) is left off the link.
 */
export function renderUtmTemplate(
  template: CtaUtmTemplate,
  vars: { brand: string; channel: string; ctaUtm: string | null },
): Partial<Record<UtmKey, string>> {
  const values: Record<string, string> = {
    "{{brand}}": vars.brand,
    "{{platform}}": platformForChannel(vars.channel),
    "{{cta_utm}}": vars.ctaUtm?.trim() ?? "",
  };
  const out: Partial<Record<UtmKey, string>> = {};
  for (const key of UTM_KEYS) {
    const raw = template[key];
    if (!raw?.trim()) continue;
    const filled = UTM_PLACEHOLDERS.reduce((acc, p) => acc.split(p).join(values[p]), raw).trim();
    if (filled) out[key] = filled;
  }
  return out;
}

/** The UTMs for one post on a CTA_OFFER_BRANDS brand. */
export function offerUtms(args: { brand: string; channel: string; ctaUtm: string | null }): Partial<Record<UtmKey, string>> {
  return renderUtmTemplate(OFFER_UTM_RULE, { brand: brandShortName(args.brand), channel: args.channel, ctaUtm: args.ctaUtm });
}
