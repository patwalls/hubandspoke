import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts, productionItems } from "@/lib/db/schema";
import { getAccountById } from "@/lib/db/accounts";

const VALID_PLATFORMS = new Set([
  "youtube",
  "instagram",
  "x",
  "tiktok",
  "linkedin",
  "threads",
  "snapchat",
  "facebook",
  "newsletter",
  "other",
]);

/**
 * Edit an account. Used by the settings UI when a handle was typed wrong
 * and the user wants to fix it without deleting + re-adding (which would
 * lose the history of production items linked to the row).
 *
 * When handle or platform changes, we clear the SC-derived fields so the
 * UI doesn't show stale avatar/followers from the old identity; next
 * Refresh click re-populates them.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const existing = await getAccountById(id);
  if (!existing) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    handle?: string;
    platform?: string;
    isActive?: boolean;
  };

  const patch: Partial<typeof accounts.$inferInsert> = {
    updatedAt: new Date(),
  };
  let identityChanged = false;

  if (typeof body.handle === "string") {
    const clean = body.handle.trim().replace(/^@/, "");
    if (!clean) {
      return NextResponse.json({ error: "handle cannot be empty" }, { status: 400 });
    }
    if (clean !== existing.handle) {
      patch.handle = clean;
      identityChanged = true;
    }
  }
  if (typeof body.platform === "string" && body.platform !== existing.platform) {
    if (!VALID_PLATFORMS.has(body.platform)) {
      return NextResponse.json(
        { error: `Unknown platform: ${body.platform}` },
        { status: 400 }
      );
    }
    patch.platform = body.platform;
    identityChanged = true;
  }
  if (typeof body.isActive === "boolean" && body.isActive !== existing.isActive) {
    patch.isActive = body.isActive;
  }

  if (identityChanged) {
    const nextPlatform = patch.platform ?? existing.platform;
    const nextHandle = patch.handle ?? existing.handle;
    const [dupe] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.platform, nextPlatform),
          sql`lower(${accounts.handle}) = ${nextHandle.toLowerCase()}`,
          ne(accounts.id, id)
        )
      )
      .limit(1);
    if (dupe) {
      return NextResponse.json(
        { error: `Account ${nextPlatform}/@${nextHandle} already exists` },
        { status: 409 }
      );
    }
    // Wipe SC-derived fields — the old avatar/followers belong to the old
    // identity. Next Refresh click re-populates.
    patch.avatarUrl = null;
    patch.bannerUrl = null;
    patch.displayName = null;
    patch.bio = null;
    patch.followerCount = null;
    patch.followingCount = null;
    patch.postCount = null;
    patch.totalViews = null;
    patch.verified = null;
    patch.location = null;
    patch.externalId = null;
    patch.url = null;
    patch.metadata = null;
    patch.lastRefreshedAt = null;
    patch.lastRefreshError = null;
  }

  await db.update(accounts).set(patch).where(eq(accounts.id, id));
  const updated = await getAccountById(id);
  return NextResponse.json({ account: updated });
}

/**
 * Soft-delete an account + every production item linked to it. Both tables
 * get a `deleted_at` timestamp stamped inside one transaction; nothing is
 * physically removed. Restore with
 *   UPDATE accounts SET deleted_at = NULL WHERE id = '...';
 *   UPDATE production_items SET deleted_at = NULL WHERE account_id = '...';
 *
 * Requires the caller to echo the account's handle as `confirmHandle` — a
 * server-side twin of the type-to-confirm dialog in the UI, so a misfired
 * fetch from somewhere else can't nuke the wrong row.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const existing = await getAccountById(id);
  if (!existing) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    confirmHandle?: string;
  };
  if (body.confirmHandle !== existing.handle) {
    return NextResponse.json(
      { error: "confirmHandle does not match the account handle" },
      { status: 400 }
    );
  }

  const now = new Date();
  const deletedCount = await db.transaction(async (tx) => {
    const stamped = await tx
      .update(productionItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(productionItems.accountId, id),
          isNull(productionItems.deletedAt)
        )
      )
      .returning({ id: productionItems.id });
    await tx
      .update(accounts)
      .set({ deletedAt: now, updatedAt: now, isActive: false })
      .where(eq(accounts.id, id));
    return stamped.length;
  });

  return NextResponse.json({
    ok: true,
    deletedProductionItems: deletedCount,
  });
}
