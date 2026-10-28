"use client";

/**
 * Client side of per-brand edit access (server side: src/lib/brand-access.ts).
 *
 * Creators can VIEW every brand but only CHANGE their assigned ones. The API
 * already 403s their changes; this makes the UI match — edit controls render
 * disabled (or hidden) instead of letting someone start an edit that can't
 * save. View controls (filters, tabs, links into content/formats, search,
 * export) must keep working.
 *
 * Two tools:
 *   - `useCanEditBrand(slug?)` — boolean for one brand. Omit the slug on
 *     brand pages: it reads the brand from the URL. Pass it explicitly on
 *     cross-brand surfaces (/all, My Work) using the row's brand.
 *   - `<EditGate>` — wraps an editing region in a disabled <fieldset>, which
 *     natively disables every input/button/select inside it. Only wrap regions
 *     that hold NO view controls; for mixed areas use the hook per control.
 *     Note fieldset doesn't reach contenteditable editors or drag-and-drop —
 *     gate those with the hook.
 */
import { createContext, useContext } from "react";
import { usePathname } from "next/navigation";

// Top-level dashboard segments that are not a brand slug.
const NON_BRAND_SEGMENTS = new Set(["all", "admin", "settings", "my-work", "notifications", "coverage"]);

type Editable = "all" | readonly string[];

// Default "all" so anything rendered outside the provider (tests, auth pages)
// behaves as before — the server check is still the real gate.
const BrandAccessContext = createContext<Editable>("all");

export function BrandAccessProvider({
  editable,
  children,
}: {
  editable: Editable;
  children: React.ReactNode;
}) {
  return <BrandAccessContext.Provider value={editable}>{children}</BrandAccessContext.Provider>;
}

export function useCanEditBrand(brandSlug?: string | null): boolean {
  const editable = useContext(BrandAccessContext);
  const pathname = usePathname();
  if (editable === "all") return true;
  const fromUrl = pathname?.split("/").filter(Boolean)[0] ?? "";
  const slug = brandSlug ?? (NON_BRAND_SEGMENTS.has(fromUrl) ? null : fromUrl);
  // No brand in play (e.g. a cross-brand page with no row) → don't guess;
  // leave it enabled and let the server decide.
  if (!slug) return true;
  return editable.includes(slug);
}

/** The raw editable-brand list ("all" = every brand). For per-row checks
 *  inside loops, where `useCanEditBrand` can't be called per item. */
export function useEditableBrands(): Editable {
  return useContext(BrandAccessContext);
}

export function EditGate({
  brand,
  children,
  className,
}: {
  brand?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  const canEdit = useCanEditBrand(brand);
  return (
    <fieldset
      disabled={!canEdit}
      // Reset fieldset's default border/padding/min-width so it lays out
      // like a plain div.
      className={`m-0 min-w-0 border-0 p-0${className ? ` ${className}` : ""}`}
    >
      {children}
    </fieldset>
  );
}
