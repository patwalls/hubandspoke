/**
 * Per-brand edit access.
 *
 * Two roles (src/lib/rbac.ts):
 *   - admin   → can view and change everything.
 *   - creator → can VIEW every brand, but can only CHANGE brands listed in
 *               their `users.brand_ids` (edited in Settings → Members).
 *
 * "Change" means anything that writes to the system: editing formats or
 * items, changing statuses, exporting clips, and any paid call (Descript,
 * LLM drafts, renders). Every mutating API route must gate on
 * `requireBrandEdit` (src/lib/auth-guards.ts) with the brand of the record it
 * touches — hiding the UI is not the gate.
 *
 * Brand membership is read from the DB on every check (not baked into the
 * JWT) so an admin changing someone's brands takes effect immediately, no
 * re-login needed. Access is per brand: a brand family (Futurepedia → Skill
 * Leap, Howfinity) grants nothing implicitly — assign each member brand.
 */
import { eq } from "drizzle-orm";
import type { Session } from "next-auth";
import { db } from "@/lib/db";
import {
  accounts,
  brands,
  clipIdeas,
  formats,
  newsletterDrafts,
  productionItems,
  users,
} from "@/lib/db/schema";

/**
 * The user's role + brands as they are NOW in the DB. The JWT's `role` is
 * frozen at sign-in, so promoting or demoting someone would otherwise only
 * apply after they log out and back in — gate on this, not `session.user.role`.
 */
export async function currentRoleAndBrands(
  userId: string
): Promise<{ role: "admin" | "creator"; brandIds: string[] } | null> {
  const [row] = await db
    .select({ role: users.role, brandIds: users.brandIds })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/** Is this user an admin right now (DB role, not the sign-in JWT)? */
export async function isAdminNow(session: Session | null | undefined): Promise<boolean> {
  if (!session?.user?.id) return false;
  return (await currentRoleAndBrands(session.user.id))?.role === "admin";
}

/** Brand slugs this user may change. Admins get `"all"`. */
export async function editableBrandSlugs(
  session: Session | null | undefined
): Promise<"all" | Set<string>> {
  if (!session?.user?.id) return new Set();
  const row = await currentRoleAndBrands(session.user.id);
  if (row?.role === "admin") return "all";
  const ids = new Set(row?.brandIds ?? []);
  if (!ids.size) return new Set();
  const all = await db.select({ id: brands.id, slug: brands.slug }).from(brands);
  return new Set(all.filter((b) => ids.has(b.id)).map((b) => b.slug));
}

export async function canEditBrand(
  session: Session | null | undefined,
  brandSlug: string
): Promise<boolean> {
  const editable = await editableBrandSlugs(session);
  return editable === "all" || editable.has(brandSlug);
}

// ── Record → brand slug resolvers. `null` = record not found. ──

export async function brandOfProductionItem(id: string): Promise<string | null> {
  const [row] = await db
    .select({ brand: productionItems.brand })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  return row?.brand ?? null;
}

export async function brandOfFormat(id: string): Promise<string | null> {
  const [row] = await db
    .select({ brand: formats.brand })
    .from(formats)
    .where(eq(formats.id, id))
    .limit(1);
  return row?.brand ?? null;
}

export async function brandOfClipIdea(id: string): Promise<string | null> {
  const [row] = await db
    .select({ brand: productionItems.brand })
    .from(clipIdeas)
    .innerJoin(productionItems, eq(productionItems.id, clipIdeas.sourceProductionItemId))
    .where(eq(clipIdeas.id, id))
    .limit(1);
  return row?.brand ?? null;
}

export async function brandOfNewsletterDraft(id: string): Promise<string | null> {
  const [row] = await db
    .select({ brand: newsletterDrafts.brand })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.id, id))
    .limit(1);
  return row?.brand ?? null;
}

export async function brandOfAccount(id: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: brands.slug })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(eq(accounts.id, id))
    .limit(1);
  return row?.slug ?? null;
}

export async function brandSlugById(id: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: brands.slug })
    .from(brands)
    .where(eq(brands.id, id))
    .limit(1);
  return row?.slug ?? null;
}
