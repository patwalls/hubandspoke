import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getAccounts, getAccountsForBrand } from "@/lib/db/accounts";
import { enqueue } from "@/jobs/enqueue";
import { platformSupportsLatest } from "@/lib/services/account-content-sync";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const brand = request.nextUrl.searchParams.get("brand");
  const rows = brand ? await getAccountsForBrand(brand) : await getAccounts();
  return NextResponse.json({ accounts: rows });
}

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

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { brandSlug, platform, handle, displayName, url } = body as {
      brandSlug?: string;
      platform?: string;
      handle?: string;
      displayName?: string | null;
      url?: string | null;
    };

    if (!brandSlug || !platform || !handle?.trim()) {
      return NextResponse.json(
        { error: "brandSlug, platform, and handle are required" },
        { status: 400 }
      );
    }
    if (!VALID_PLATFORMS.has(platform)) {
      return NextResponse.json(
        { error: `Unknown platform: ${platform}` },
        { status: 400 }
      );
    }
    const brand = await fetchBrandBySlug(brandSlug);
    if (!brand) {
      return NextResponse.json(
        { error: `Unknown brand: ${brandSlug}` },
        { status: 400 }
      );
    }

    const cleanHandle = handle.trim().replace(/^@/, "");

    const [row] = await db
      .insert(accounts)
      .values({
        brandId: brand.id,
        platform,
        handle: cleanHandle,
        displayName: displayName ?? null,
        url: url ?? null,
      })
      // The unique index is on `(platform, lower(handle))` — an expression
      // index that can't be named as an ON CONFLICT target by column list.
      // Bare `onConflictDoNothing()` lets Postgres match any unique index,
      // which is what we want: a case-insensitive handle clash on the same
      // platform returns an empty row and we surface the 409 below.
      .onConflictDoNothing()
      .returning();

    if (!row) {
      return NextResponse.json(
        { error: `Account ${platform}/@${cleanHandle} already exists` },
        { status: 409 }
      );
    }

    // Auto-sync on create: every SC-supported platform gets a content pull
    // and a profile refresh. Best-effort — enqueue failures don't block the
    // create response; the user can retry from the settings UI. For
    // paginatable platforms (YouTube, Instagram, TikTok, LinkedIn)
    // `mode: "backfill"` walks the full catalog; for latest-only platforms
    // (X, Threads) the task collapses backfill to a single-page fetch
    // internally. Newsletter/other are excluded: no SC coverage.
    if (platformSupportsLatest(row.platform)) {
      try {
        await enqueue(
          "account-content-sync",
          { accountId: row.id, mode: "backfill", maxPages: 10 },
          {
            jobKey: `account-content-sync-${row.id}-backfill`,
            jobKeyMode: "unsafe_dedupe",
          }
        );
      } catch (err) {
        console.error("account-content-sync enqueue failed:", err);
      }
      try {
        await enqueue(
          "account-refresh",
          { accountId: row.id },
          {
            jobKey: `account-refresh-${row.id}`,
            jobKeyMode: "unsafe_dedupe",
          }
        );
      } catch (err) {
        console.error("account-refresh enqueue failed:", err);
      }
    }

    return NextResponse.json({ account: row });
  } catch (error) {
    console.error("Error creating account:", error);
    return NextResponse.json(
      { error: "Failed to create account" },
      { status: 500 }
    );
  }
}
