import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getAccounts, getAccountsForBrand } from "@/lib/db/accounts";

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
      .onConflictDoNothing({
        target: [accounts.platform, accounts.handle],
      })
      .returning();

    if (!row) {
      return NextResponse.json(
        { error: `Account ${platform}/@${cleanHandle} already exists` },
        { status: 409 }
      );
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
