/**
 * Cache tags for the In Production / queue report
 * (src/lib/services/production-report.ts).
 *
 * Each brand's report is tagged with the shared tag AND its own, so a write
 * that knows which brands it touched expires only those (and the cross-brand
 * `/all` report, which sums them). A write that doesn't say expires all.
 */

export const PRODUCTION_REPORT_TAG = "production-report";

/** Cache tag for one brand's report (`"all"` is the cross-brand sentinel). */
export function productionReportTag(brand: string): string {
  return `${PRODUCTION_REPORT_TAG}:${brand}`;
}

/**
 * The brands a write touched, cleaned: blanks dropped, de-duplicated, and
 * `null` when we can't name any (or a caller passed none) — meaning "every
 * brand", the safe default.
 */
export function touchedBrands(
  brands: ReadonlyArray<string | null | undefined> | undefined,
): string[] | null {
  if (!brands) return null;
  const out = [...new Set(brands.filter((b): b is string => !!b && b !== "all"))];
  return out.length ? out : null;
}

/** The tags to expire for a write that touched `brands` (null = every brand). */
export function productionReportTagsToExpire(brands: string[] | null): string[] {
  if (!brands) return [PRODUCTION_REPORT_TAG];
  return [...brands.map(productionReportTag), productionReportTag("all")];
}
