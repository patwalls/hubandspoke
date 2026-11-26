/**
 * brands-at-a-glance M2: notice when someone is flipping brand dashboards.
 *
 * The people who check several brands open 3–4 brand dashboards in the same
 * hour, a few seconds each, just to read the week's numbers — the exact job
 * of /all's "Brands this week" line, which none of them find on their own.
 * The brand dashboard keeps a small per-browser list of which brands it was
 * opened for and when; once it has seen 3 different brands inside an hour it
 * offers one quiet link to /all. Nobody else ever sees the link.
 */

/** One brand dashboard open: brand slug + epoch ms. */
export interface BrandVisit {
  slug: string;
  at: number;
}

export const SCAN_WINDOW_MS = 60 * 60 * 1000;
export const SCAN_MIN_BRANDS = 3;

/** Keep only well-formed visits (localStorage is user-editable / may be stale). */
export function parseVisits(raw: string | null): BrandVisit[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is BrandVisit =>
        !!x && typeof x === "object" && typeof (x as BrandVisit).slug === "string" && Number.isFinite((x as BrandVisit).at),
    );
  } catch {
    return [];
  }
}

/**
 * The visit list after opening `slug`'s dashboard at `now`: one entry per
 * brand (latest open wins), only the last hour. /all is not a brand — it is
 * where the link goes — so opening it is not recorded.
 */
export function recordBrandVisit(visits: BrandVisit[], slug: string, now: number): BrandVisit[] {
  const recent = visits.filter((v) => v.slug !== slug && now - v.at < SCAN_WINDOW_MS && v.at <= now);
  if (slug === "all") return recent;
  return [...recent, { slug, at: now }];
}

/** True once 3+ different brands' dashboards were opened within the hour. */
export function isScanningBrands(visits: BrandVisit[], now: number): boolean {
  const brands = new Set(
    visits.filter((v) => v.slug !== "all" && now - v.at < SCAN_WINDOW_MS && v.at <= now).map((v) => v.slug),
  );
  return brands.size >= SCAN_MIN_BRANDS;
}
