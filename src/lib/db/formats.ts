import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";

export interface ClippableFormatRow {
  id: string;
  name: string;
  slug: string;
  clipTargetPostType: string | null;
  clipTargetPlatform: string[] | null;
  clipAspectRatio: string | null;
}

/**
 * Convert a format name to a URL-safe slug. Lowercase, alphanumerics
 * only, single hyphens as separators. Used to build per-format Queue
 * tab routes ("/queue/repackage-section-w-hook", "/queue/x-quotables")
 * and to look the format back up by slug at request time.
 *
 * Pure function so tests can assert collision behavior. If two formats
 * on the same brand slugify to the same string the route's lookup
 * returns the first by created_at — operators should rename one.
 */
export function formatNameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Load every clippable format for a brand, ordered by created_at so the
 * Queue's per-format tab order is stable across renders and the
 * "primary" format (first by creation) is the one that legacy default-
 * target callers resolve through `getPrimaryClippableFormat`.
 */
export async function getClippableFormats(
  brand: string,
): Promise<ClippableFormatRow[]> {
  const rows = await db
    .select({
      id: formats.id,
      name: formats.name,
      clipTargetPostType: formats.clipTargetPostType,
      clipTargetPlatform: formats.clipTargetPlatform,
      clipAspectRatio: formats.clipAspectRatio,
    })
    .from(formats)
    .where(and(eq(formats.brand, brand), eq(formats.isClippableFormat, true)))
    .orderBy(asc(formats.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: formatNameToSlug(r.name),
    clipTargetPostType: r.clipTargetPostType,
    clipTargetPlatform:
      Array.isArray(r.clipTargetPlatform) && r.clipTargetPlatform.length > 0
        ? (r.clipTargetPlatform as string[])
        : null,
    clipAspectRatio: r.clipAspectRatio,
  }));
}

/**
 * Lightweight map of every format on the brand keyed by name → id. Used
 * by the Queue table to render the Format column as a link to the
 * format detail page without an extra fetch per row. Includes ALL
 * formats (not just clippable) since a row's format could be anything
 * the brand has — Full Video On LinkedIn, Slideshow, etc.
 */
export async function getFormatNameToIdMap(
  brand: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: formats.id, name: formats.name })
    .from(formats)
    .where(eq(formats.brand, brand));
  const out: Record<string, string> = {};
  for (const r of rows) out[r.name] = r.id;
  return out;
}

/**
 * Resolve a clippable format on a brand by its kebab-cased slug. Returns
 * the first match by created_at — the slug-collision tiebreaker. Null
 * when no match (typically a stale URL or a brand-mismatched slug).
 */
export async function getClippableFormatBySlug(
  brand: string,
  slug: string,
): Promise<ClippableFormatRow | null> {
  const all = await getClippableFormats(brand);
  return all.find((f) => f.slug === slug) ?? null;
}

/**
 * Resolve the aspect ratio for clips in this format. Falls back to a
 * post_type-derived default when the format hasn't set one explicitly:
 * 9:16 for Reel/Shorts/TikTok, 16:9 for X / YouTube long. Default 9:16.
 * Used by Descript composition builders so a clip's frame matches the
 * intended surface without operators having to set the column on every
 * format.
 */
export function resolveClipAspectRatio(
  format: Pick<ClippableFormatRow, "clipAspectRatio" | "clipTargetPostType">,
): "9:16" | "16:9" {
  if (format.clipAspectRatio === "9:16") return "9:16";
  if (format.clipAspectRatio === "16:9") return "16:9";
  const pt = format.clipTargetPostType ?? "";
  if (
    pt === "instagram_reel" ||
    pt === "tiktok" ||
    pt === "youtube_shorts"
  ) {
    return "9:16";
  }
  if (pt === "x" || pt === "youtube_long") return "16:9";
  return "9:16";
}
