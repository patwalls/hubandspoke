import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccountsForBrand } from "@/lib/db/accounts";
import { inferAccountFromUrl } from "@/lib/infer-post-type";
import { fetchPostMetadataFromUrl } from "@/lib/services/post-metadata";

/**
 * POST /api/production-items/preview-link
 *
 * Takes a published-post URL + brand slug, returns best-effort metadata
 * pulled from the Scrape Creators API so the Add-Post dialog can pre-fill
 * title / date / metrics / thumbnail. Always 200s on a recognized URL —
 * callers treat null fields as "user fills in manually" rather than an error.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const brand = typeof body.brand === "string" ? body.brand.trim() : "";

    if (!url || !brand) {
      return NextResponse.json(
        { error: "url and brand are required" },
        { status: 400 }
      );
    }

    // Validate the URL before anything else so we give a clean 400 instead
    // of leaking a parse error up through SC.
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: "url is not a valid URL" }, { status: 400 });
    }

    const accounts = await getAccountsForBrand(brand);
    const matchedAccount = inferAccountFromUrl(url, accounts);
    const metadata = await fetchPostMetadataFromUrl(url);

    return NextResponse.json({
      accountId: matchedAccount?.id ?? null,
      accountMatch: matchedAccount
        ? { handle: matchedAccount.handle, platform: matchedAccount.platform }
        : null,
      postType: metadata.postType,
      platform: metadata.platform,
      title: metadata.title,
      publishedDate: metadata.publishedDate,
      publishedAt: metadata.publishedAt,
      publishedLink: metadata.normalizedUrl,
      views: metadata.views,
      likes: metadata.likes,
      comments: metadata.comments,
      thumbnail: metadata.thumbnail,
      authorHandle: metadata.authorHandle,
      contentBody: metadata.contentBody,
      warning: metadata.warning,
    });
  } catch (error) {
    console.error("preview-link failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
