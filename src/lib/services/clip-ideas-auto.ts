import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getClippableFormats } from "@/lib/db/formats";

// Auto-generation costs real money (~$0.10 Sonnet sections + ~$0.003/Haiku
// hook per (section, format) — ~$0.21 per pillar at 3 clippable formats), so
// it's allowlisted per brand and capped by recency. The post-transcribe
// auto-enqueue was removed globally 2026-05-03 over Sonnet spend; this is the
// deliberately narrow reintroduction (2026-06-09): new Starter Story
// long-form only.
const DEFAULT_AUTO_BRANDS = ["starter-story"];

// Recency cap: anything published longer ago than this never auto-fires,
// even when its transcript lands late. Protects against whisper *backfill*
// scripts (which enqueue transcribe-whisper for years-old videos) fanning
// out into surprise LLM spend. 7 days comfortably covers the normal flow
// (publish → hourly archive → whisper within ~2h) plus a multi-day archiver
// outage like 2026-06-06.
const DEFAULT_MAX_AGE_DAYS = 7;

export function getAutoClipIdeaBrands(): string[] {
  const env = process.env.AUTO_CLIP_IDEAS_BRANDS;
  if (env === undefined) return DEFAULT_AUTO_BRANDS;
  // Explicitly-set empty string = kill switch (auto-generation off).
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

export function getAutoClipIdeaMaxAgeDays(): number {
  const env = Number(process.env.AUTO_CLIP_IDEAS_MAX_AGE_DAYS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_AGE_DAYS;
}

export interface AutoClipIdeaGateInput {
  brand: string | null;
  status: string | null;
  postType: string | null;
  sourceType: string | null;
  publishedAt: Date | null;
  publishedDate: string | null;
}

/**
 * Pure gate: should this item auto-generate clip ideas now that its
 * transcript exists? Mirrors the service's own backfill gate
 * (original + youtube_long) and adds the cost gates the service does NOT
 * have: brand allowlist, Published status, and the recency cap.
 */
export function evaluateAutoClipIdeaGates(
  item: AutoClipIdeaGateInput,
  now: Date = new Date(),
): { eligible: true } | { eligible: false; reason: string } {
  const brands = getAutoClipIdeaBrands();
  if (!item.brand || !brands.includes(item.brand)) {
    return { eligible: false, reason: `brand-not-auto-enabled-${item.brand ?? "null"}` };
  }
  if (item.status !== "Published") {
    return { eligible: false, reason: `status-${item.status ?? "null"}` };
  }
  if (item.sourceType !== "original") {
    return { eligible: false, reason: `source-type-${item.sourceType ?? "null"}` };
  }
  if (item.postType !== "youtube_long") {
    return { eligible: false, reason: `post-type-${item.postType ?? "null"}` };
  }
  const publishedTs =
    item.publishedAt ??
    (item.publishedDate ? new Date(`${item.publishedDate}T00:00:00Z`) : null);
  if (!publishedTs || Number.isNaN(publishedTs.getTime())) {
    return { eligible: false, reason: "no-publish-date" };
  }
  const maxAgeMs = getAutoClipIdeaMaxAgeDays() * 24 * 3600_000;
  if (now.getTime() - publishedTs.getTime() > maxAgeMs) {
    return { eligible: false, reason: `published-too-old-${publishedTs.toISOString().slice(0, 10)}` };
  }
  return { eligible: true };
}

/**
 * Resolve the generate-clip-ideas fan-out for an item, or the reason it
 * shouldn't fire. One job per clippable format on the brand, mirroring the
 * manual route's fan-out. The caller enqueues with `force: false`, so the
 * service's per-(pillar, format) idempotency makes accidental double-fires
 * free (it short-circuits before any LLM call).
 */
export async function selectAutoClipIdeaJobs(productionItemId: string): Promise<
  | { eligible: true; jobs: Array<{ targetFormatId: string; formatName: string }> }
  | { eligible: false; reason: string }
> {
  const [item] = await db
    .select({
      brand: productionItems.brand,
      status: productionItems.status,
      postType: productionItems.postType,
      sourceType: productionItems.sourceType,
      publishedAt: productionItems.publishedAt,
      publishedDate: productionItems.publishedDate,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (!item) {
    return { eligible: false, reason: "item-not-found" };
  }

  const gate = evaluateAutoClipIdeaGates(item);
  if (!gate.eligible) {
    return gate;
  }

  const clippable = await getClippableFormats(item.brand!);
  if (clippable.length === 0) {
    return { eligible: false, reason: "no-clippable-formats" };
  }

  return {
    eligible: true,
    jobs: clippable.map((f) => ({ targetFormatId: f.id, formatName: f.name })),
  };
}
