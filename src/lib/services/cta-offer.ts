// Per-format CTA offer resolution — the non–Starter Story answer to "which
// link does this post send people to?".
//
// Starter Story keeps its own path (tracked-cta.ts: Opus picks an episode or
// lead magnet, then mints a go.starterstory.com link). Brands listed in
// CTA_OFFER_BRANDS (MATG only today) instead get a rule set on the post's
// FORMAT (`formats.cta_strategy`):
//
//   pillar_offer — the offer link in the pillar video's YouTube description
//                  (MATG descriptions open with "Free guide to …:
//                  https://clickhubspot.com/xxxx"). Haiku picks the offer out
//                  of the description, we follow the clickhubspot redirect to
//                  the real offer page, strip its old tracking params, and
//                  cache the clean URL on the pillar.
//   pillar_video — the pillar video itself ("watch the full video").
//   fixed        — `formats.cta_fixed_url`.
//   (none)       — the brand's `brands.cta_fallback_url`.
//
// Any strategy that can't produce a link falls through to the brand fallback;
// with no fallback the result is null and the caller leaves the CTA blank.
// The post's UTMs go on last: one fixed rule for every non–Starter Story
// brand (OFFER_UTM_RULE in src/lib/cta-offer-brands.ts).

import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, formats, productionItems } from "@/lib/db/schema";
import { isCtaStrategy, offerUtms, usesCtaOffer, type CtaStrategy } from "@/lib/cta-offer-brands";

export { CTA_OFFER_BRANDS, CTA_STRATEGIES, isCtaStrategy, usesCtaOffer, type CtaStrategy } from "@/lib/cta-offer-brands";

const MODEL = "claude-haiku-4-5-20251001";

export interface ResolvedCtaOffer {
  /** Final destination with the post's UTMs applied. */
  url: string;
  /** Copy for the CTA line ("Free guide to …"), when the source had one. */
  label: string | null;
  source: CtaStrategy | "fallback";
}

export interface CtaOfferDeps {
  client?: Anthropic;
  fetchImpl?: typeof fetch;
}

// ── URL helpers (pure, unit-tested) ────────────────────────────────────────

// HubSpot's link shorteners. Only these get redirect-resolved — anything
// else is assumed to already be the real offer page.
const SHORT_LINK_HOSTS = new Set([
  "clickhubspot.com",
  "www.clickhubspot.com",
  "click.hubspot.com",
  "hubs.ly",
  "hubs.la",
  "hubs.li",
]);

export function isHubSpotShortLink(url: string): boolean {
  try {
    return SHORT_LINK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Tracking params left over from the link's original placement (the YouTube
// description): UTMs plus HubSpot's own click/session params. The post's
// fresh UTMs replace them.
const TRACKING_PARAM_PREFIXES = ["utm_", "hsa_", "_hs", "__hs"];
const TRACKING_PARAMS = new Set(["hsctatracking", "hslang_tracking"]);

export function stripTrackingParams(url: string): string {
  const u = new URL(url);
  for (const key of Array.from(u.searchParams.keys())) {
    const k = key.toLowerCase();
    if (TRACKING_PARAMS.has(k) || TRACKING_PARAM_PREFIXES.some((p) => k.startsWith(p))) {
      u.searchParams.delete(key);
    }
  }
  return u.toString();
}

export function applyUtms(url: string, utms: Partial<Record<string, string>>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(utms)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

const MAX_HOPS = 6;
const HOP_TIMEOUT_MS = 5_000;

export type ResolveRedirectResult =
  | { ok: true; url: string }
  | { ok: false; reason: "too-many-hops" | "stuck-on-short-link" | "http-error"; message?: string };

/**
 * Follow a short link's redirects to the page it lands on, without loading
 * that page. Note: this hits HubSpot's redirect like a real visitor would, so
 * it may count as one click in HubSpot's link stats — callers cache the
 * result so each pillar is resolved once.
 */
export async function resolveRedirects(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolveRedirectResult> {
  let current = url;
  const seen = new Set<string>();
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (seen.has(current)) return { ok: false, reason: "too-many-hops", message: "redirect loop" };
    seen.add(current);
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, reason: "http-error", message: err instanceof Error ? err.message : String(err) };
    }
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (isHubSpotShortLink(current)) return { ok: false, reason: "stuck-on-short-link" };
    return { ok: true, url: current };
  }
  return { ok: false, reason: "too-many-hops" };
}

// ── Offer extraction from a YouTube description (Haiku) ───────────────────

export type ExtractOfferResult =
  | { ok: true; offer: { label: string; url: string } | null }
  | { ok: false; failure: { reason: "llm-error"; message: string } };

const EXTRACT_SYSTEM_PROMPT = `You read a YouTube video description and find the video's PRIMARY OFFER: the free resource / guide / template / download the creator is promoting to viewers.

RULES
- The offer is usually near the top, e.g. "Free guide to X: https://…". Pick the main one.
- Ignore links to social profiles, other videos or playlists, sponsors, podcasts apps, merch, newsletters (unless the newsletter IS the offer), and timestamps.
- "label" is the offer's own wording, without the URL and without a trailing colon (e.g. "Free guide to automate your Instagram marketing with Muse AI").
- "url" must be copied EXACTLY as it appears in the description.
- If there is no clear offer, set found=false.

Never respond with plain text. Always call return_offer exactly once.`;

const EXTRACT_TOOLS: Anthropic.Tool[] = [
  {
    name: "return_offer",
    description: "Return the description's primary offer link, or found=false when there isn't one.",
    input_schema: {
      type: "object" as const,
      properties: {
        found: { type: "boolean" },
        label: { type: "string", description: "The offer's wording, no URL, no trailing colon." },
        url: { type: "string", description: "The offer link, copied exactly from the description." },
      },
      required: ["found"],
    },
  },
];

const DESCRIPTION_CHAR_BUDGET = 6_000;

/** Validates the model's tool input. Exported for unit tests. */
export function parseOfferToolInput(
  input: unknown,
  description: string,
): { label: string; url: string } | null {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (obj.found !== true) return null;
  const url = typeof obj.url === "string" ? obj.url.trim() : "";
  const label = typeof obj.label === "string" ? obj.label.trim().replace(/:\s*$/, "") : "";
  // Guard against a hallucinated link: it has to be a real http(s) URL that
  // is literally in the description.
  if (!url || !description.includes(url)) return null;
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return null;
  }
  if (protocol !== "https:" && protocol !== "http:") return null;
  return { label, url };
}

export async function extractOfferFromDescription(
  description: string,
  client: Anthropic = new Anthropic(),
): Promise<ExtractOfferResult> {
  const text = description.slice(0, DESCRIPTION_CHAR_BUDGET);
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: EXTRACT_SYSTEM_PROMPT,
      tools: EXTRACT_TOOLS,
      tool_choice: { type: "tool", name: "return_offer" },
      messages: [{ role: "user", content: `## YOUTUBE DESCRIPTION\n${text}` }],
    });
    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "return_offer",
    );
    return { ok: true, offer: block ? parseOfferToolInput(block.input, text) : null };
  } catch (err) {
    return { ok: false, failure: { reason: "llm-error", message: err instanceof Error ? err.message : String(err) } };
  }
}

// ── Pillar offer (cached on the pillar row) ────────────────────────────────

/**
 * The pillar's clean offer {url, label}, from cache when the pillar has
 * already been checked. Caches "no offer" too, so a description without one
 * isn't re-sent to the LLM on every derivative. Transient failures (LLM error,
 * redirect couldn't resolve) are NOT cached, so the next call retries.
 */
export async function getPillarOffer(
  pillarId: string,
  deps: CtaOfferDeps = {},
): Promise<{ url: string; label: string | null } | null> {
  const [pillar] = await db
    .select({
      description: productionItems.description,
      ctaOfferUrl: productionItems.ctaOfferUrl,
      ctaOfferLabel: productionItems.ctaOfferLabel,
      ctaOfferCheckedAt: productionItems.ctaOfferCheckedAt,
    })
    .from(productionItems)
    .where(eq(productionItems.id, pillarId))
    .limit(1);
  if (!pillar) return null;
  if (pillar.ctaOfferCheckedAt) {
    return pillar.ctaOfferUrl ? { url: pillar.ctaOfferUrl, label: pillar.ctaOfferLabel } : null;
  }
  if (!pillar.description?.trim()) return null;

  const extracted = await extractOfferFromDescription(pillar.description, deps.client);
  if (!extracted.ok) {
    console.error(`[cta-offer] offer extraction failed pillar=${pillarId}: ${extracted.failure.message}`);
    return null;
  }

  let offer: { url: string; label: string | null } | null = null;
  if (extracted.offer) {
    let finalUrl = extracted.offer.url;
    if (isHubSpotShortLink(finalUrl)) {
      const resolved = await resolveRedirects(finalUrl, deps.fetchImpl);
      if (!resolved.ok) {
        console.error(
          `[cta-offer] could not resolve ${finalUrl} pillar=${pillarId}: ${resolved.reason}${resolved.message ? ` (${resolved.message})` : ""}`,
        );
        return null;
      }
      finalUrl = resolved.url;
    }
    offer = { url: stripTrackingParams(finalUrl), label: extracted.offer.label || null };
  }

  await db
    .update(productionItems)
    .set({
      ctaOfferUrl: offer?.url ?? null,
      ctaOfferLabel: offer?.label ?? null,
      ctaOfferCheckedAt: new Date(),
    })
    .where(eq(productionItems.id, pillarId));
  return offer;
}

// ── Resolver ───────────────────────────────────────────────────────────────

const PILLAR_VIDEO_LABEL = "Watch the full episode";

export async function resolveCtaOffer(
  args: { productionItemId: string; channel: string },
  deps: CtaOfferDeps = {},
): Promise<ResolvedCtaOffer | null> {
  const [item] = await db
    .select({
      brand: productionItems.brand,
      format: productionItems.format,
      utmCampaign: productionItems.utmCampaign,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, args.productionItemId))
    .limit(1);
  if (!item || !usesCtaOffer(item.brand)) return null;

  const [fmt] = item.format
    ? await db
        .select({ ctaStrategy: formats.ctaStrategy, ctaFixedUrl: formats.ctaFixedUrl })
        .from(formats)
        .where(and(eq(formats.brand, item.brand), eq(formats.name, item.format)))
        .limit(1)
    : [];
  const strategy = isCtaStrategy(fmt?.ctaStrategy) ? fmt.ctaStrategy : null;

  const [brandRow] = await db
    .select({ ctaFallbackUrl: brands.ctaFallbackUrl })
    .from(brands)
    .where(eq(brands.slug, item.brand))
    .limit(1);
  const utms = offerUtms({ brand: item.brand, channel: args.channel, ctaUtm: item.utmCampaign ?? null });
  const withUtms = (url: string) => applyUtms(stripTrackingParams(url), utms);

  let picked: { url: string; label: string | null; source: ResolvedCtaOffer["source"] } | null = null;
  if (strategy === "pillar_offer" && item.pillarContentItemId) {
    const offer = await getPillarOffer(item.pillarContentItemId, deps);
    if (offer) picked = { ...offer, source: "pillar_offer" };
  } else if (strategy === "pillar_video" && item.pillarContentItemId) {
    const [pillar] = await db
      .select({ youtubeUrl: productionItems.youtubeUrl, publishedLink: productionItems.publishedLink })
      .from(productionItems)
      .where(eq(productionItems.id, item.pillarContentItemId))
      .limit(1);
    const url = pillar?.youtubeUrl ?? pillar?.publishedLink ?? null;
    if (url) picked = { url, label: PILLAR_VIDEO_LABEL, source: "pillar_video" };
  } else if (strategy === "fixed" && fmt?.ctaFixedUrl) {
    picked = { url: fmt.ctaFixedUrl, label: null, source: "fixed" };
  }

  if (!picked && brandRow?.ctaFallbackUrl) {
    picked = { url: brandRow.ctaFallbackUrl, label: null, source: "fallback" };
  }
  if (!picked) return null;

  try {
    return { url: withUtms(picked.url), label: picked.label, source: picked.source };
  } catch {
    // Unparseable configured URL (fixed / fallback typed by hand).
    console.error(`[cta-offer] invalid offer url "${picked.url}" item=${args.productionItemId}`);
    return null;
  }
}

/** The reply-CTA text for an offer: "<label>:\n<url>". */
export function formatOfferCta(offer: Pick<ResolvedCtaOffer, "url" | "label">): string {
  return `${offer.label?.trim() || "More here"}:\n${offer.url}`;
}
