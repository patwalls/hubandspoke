import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accounts, crossPostRules } from "@/lib/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getAccountById } from "@/lib/db/accounts";

/**
 * GET /api/cross-post-rules?brand=<slug>
 *
 * Returns rules with joined source/target account info so the UI can
 * render each side as an AccountBadge. Rows created before the accounts
 * rollout (account FKs still null) carry their legacy source/target
 * platform strings in the same response — the client falls back to those
 * for display when `sourceAccount`/`targetAccount` are null.
 */
export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand || !(await fetchBrandBySlug(brand))) {
    return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
  }

  // Fetch rules first, then bulk-fetch the accounts they reference in a
  // single IN query. 18 accounts × ~10 rules is tiny — the two round trips
  // avoid dealing with two aliases of the same table in a single join.
  const rules = await db
    .select()
    .from(crossPostRules)
    .where(eq(crossPostRules.brand, brand))
    .orderBy(
      asc(crossPostRules.sourcePlatform),
      asc(crossPostRules.targetPlatform)
    );

  const neededIds = new Set<string>();
  for (const r of rules) {
    if (r.sourceAccountId) neededIds.add(r.sourceAccountId);
    if (r.targetAccountId) neededIds.add(r.targetAccountId);
  }
  const accountRows = neededIds.size
    ? await db
        .select({
          id: accounts.id,
          platform: accounts.platform,
          handle: accounts.handle,
          displayName: accounts.displayName,
        })
        .from(accounts)
        .where(inArray(accounts.id, Array.from(neededIds)))
    : [];
  const accById = new Map(accountRows.map((a) => [a.id, a]));

  return NextResponse.json({
    rules: rules.map((r) => ({
      ...r,
      sourceAccount: r.sourceAccountId ? accById.get(r.sourceAccountId) ?? null : null,
      targetAccount: r.targetAccountId ? accById.get(r.targetAccountId) ?? null : null,
    })),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      brand,
      sourceAccountId,
      targetAccountId,
      viewThreshold,
      active,
    } = body as {
      brand?: string;
      sourceAccountId?: string;
      targetAccountId?: string;
      viewThreshold?: number;
      active?: boolean;
    };

    if (!brand || !(await fetchBrandBySlug(brand))) {
      return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    }
    if (!sourceAccountId || !targetAccountId) {
      return NextResponse.json(
        { error: "sourceAccountId and targetAccountId are required" },
        { status: 400 }
      );
    }
    if (sourceAccountId === targetAccountId) {
      return NextResponse.json(
        { error: "sourceAccountId and targetAccountId must differ" },
        { status: 400 }
      );
    }
    const n = Number(viewThreshold);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return NextResponse.json(
        { error: "viewThreshold must be a non-negative integer" },
        { status: 400 }
      );
    }

    // Resolve accounts so we can derive a legacy-string fallback for the
    // source_platform / target_platform columns. The scanner prefers the
    // FK path but falls back to strings for rules that predate accounts.
    const [src, tgt] = await Promise.all([
      getAccountById(sourceAccountId),
      getAccountById(targetAccountId),
    ]);
    if (!src || !tgt) {
      return NextResponse.json({ error: "Account not found" }, { status: 400 });
    }

    // `legacy-string` = the shape the scanner used to match. We set it to
    // a canonical, platform-scoped string so if the FK path ever fails
    // the legacy matcher still lands on *something* reasonable.
    const legacySrcString = `${src.platform}:@${src.handle}`;
    const legacyTgtString = `${tgt.platform}:@${tgt.handle}`;

    const [row] = await db
      .insert(crossPostRules)
      .values({
        brand,
        sourcePlatform: legacySrcString,
        targetPlatform: legacyTgtString,
        sourceAccountId,
        targetAccountId,
        viewThreshold: n,
        active: active !== false,
      })
      .onConflictDoUpdate({
        target: [
          crossPostRules.brand,
          crossPostRules.sourcePlatform,
          crossPostRules.targetPlatform,
        ],
        set: {
          sourceAccountId,
          targetAccountId,
          viewThreshold: n,
          active: active !== false,
          updatedAt: new Date(),
        },
      })
      .returning();

    return NextResponse.json({ rule: row });
  } catch (error) {
    console.error("Error creating cross-post rule:", error);
    return NextResponse.json(
      { error: "Failed to save rule" },
      { status: 500 }
    );
  }
}
