import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";

// Guards against `production_items.format` drifting away from real rows in
// the `formats` table. The column is text (not an FK) for legacy reasons,
// so writes have to validate at the API layer.
//
// History: a hardcoded post-type → format default in account-content-sync
// was stamping every new tweet with `format='Tweet'` even though no
// "Tweet" row existed in `formats`. The default was removed 2026-05-02 and
// this validator is the belt-and-braces that prevents a similar drift
// from any other write site.

export interface FormatValidationOk {
  ok: true;
  /** The canonical format name as stored in the formats table (preserves
   *  capitalization). Use this when writing to productionItems.format so
   *  the row matches the formats table exactly. */
  canonicalName: string;
}

export interface FormatValidationErr {
  ok: false;
  /** Human-readable error suitable for surfacing in a 400 response. */
  error: string;
}

export type FormatValidationResult =
  | FormatValidationOk
  | FormatValidationErr;

/**
 * Validate that `name` matches a row in `formats` for `brand`. Case-
 * insensitive — matches the unique index on `(brand, lower(name))`.
 *
 * Use the returned `canonicalName` when writing so capitalization is the
 * one operators see in the formats UI.
 */
export async function validateFormatName(
  brand: string,
  name: string
): Promise<FormatValidationResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Format name is empty." };
  }

  const [match] = await db
    .select({ name: formats.name })
    .from(formats)
    .where(
      and(
        eq(formats.brand, brand),
        sql`lower(${formats.name}) = lower(${trimmed})`
      )
    )
    .limit(1);

  if (!match) {
    return {
      ok: false,
      error: `Format "${trimmed}" doesn't exist for this brand. Create it on the Formats page first, or pick an existing format.`,
    };
  }

  return { ok: true, canonicalName: match.name };
}

/**
 * Convenience: takes an arbitrary input (string / null / undefined) and
 * returns either:
 *  - { ok: true, value: null }            — caller passed null/empty/undefined
 *  - { ok: true, value: <canonical name> } — name validated
 *  - { ok: false, error: <message> }      — name doesn't exist for this brand
 *
 * Most write paths can drop this in directly.
 */
export async function normalizeFormatForWrite(
  brand: string,
  name: string | null | undefined
): Promise<
  | { ok: true; value: string | null }
  | { ok: false; error: string }
> {
  if (name == null) return { ok: true, value: null };
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  const result = await validateFormatName(brand, trimmed);
  if (!result.ok) return result;
  return { ok: true, value: result.canonicalName };
}
