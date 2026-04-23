import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { getAccountById } from "@/lib/db/accounts";

const VALID_PLATFORMS = new Set([
  "youtube",
  "instagram",
  "x",
  "tiktok",
  "linkedin",
  "threads",
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
