// Brand data now lives in the `brands` table. Fetch via `@/lib/db/brands`
// (server-only) — `getBrands()`, `fetchBrandBySlug()`, etc.
//
// This file retains `DEFAULT_BRAND` so top-level redirect targets stay a
// cheap synchronous constant. Any code that used to import { BRANDS } should
// switch to `await getBrands()` from `@/lib/db/brands`.

export const DEFAULT_BRAND = "starter-story";

/** @deprecated Route params are plain strings now — the brand list is
 *  data-driven. Kept so existing imports compile during the cutover. */
export type BrandSlug = string;
