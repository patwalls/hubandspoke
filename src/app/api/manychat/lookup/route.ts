import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  normalizeKeyword,
  type ManychatLookupResponse,
} from "@/lib/services/manychat";

export const dynamic = "force-dynamic";

const NOT_FOUND: ManychatLookupResponse = {
  found: "No",
  link: "",
  post_title: "",
};

/**
 * POST /api/manychat/lookup
 *
 * Called by the ManyChat "External Request" action inside our IG comment-to-DM
 * automation. Receives the raw comment text, returns the matching post's link.
 *
 * Headers:  x-manychat-secret: $MANYCHAT_WEBHOOK_SECRET
 * Body:     { "comment_text": "<the IG comment>" }
 * Response: { found: "Yes"|"No", link, post_title } — always 2xx with
 *           `found:"No"` on a miss so ManyChat continues the flow (its
 *           branch reads `found` via string equality against text Custom
 *           Field). 401 only on bad/missing secret.
 *
 * Matching logic: we normalize both the stored keyword and the inbound comment
 * text (lowercase + collapse whitespace), then try exact match, then a
 * word-boundary contains match (so "send me guide saas pls" still matches a
 * stored keyword of "guide saas"). Per-account scoping isn't needed today
 * because the unique index already prevents cross-post collisions inside an
 * account; if we ever serve multiple ManyChat workspaces we'll add an
 * `account_handle` field to the request.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.MANYCHAT_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[manychat/lookup] MANYCHAT_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }
  if (request.headers.get("x-manychat-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let commentText: string;
  try {
    const body = await request.json();
    commentText = typeof body?.comment_text === "string" ? body.comment_text : "";
  } catch {
    console.log("[manychat/lookup] body parse failed");
    return NextResponse.json(NOT_FOUND);
  }

  const normalized = normalizeKeyword(commentText);
  // One-line log per request — kept for now to settle whether the IG comment
  // text actually arrives in `comment_text` (vs the writeup's claim that
  // ManyChat's Last Text Input only carries DM/Story replies). Strip after a
  // few real interactions confirm.
  console.log(
    `[manychat/lookup] comment_text=${JSON.stringify(commentText)} normalized=${JSON.stringify(normalized)}`
  );
  if (!normalized) return NextResponse.json(NOT_FOUND);

  // Pull every configured (keyword, link) pair. Expected size: tens to low
  // thousands. A single indexed scan, well under the 10s ManyChat budget.
  const candidates = await db
    .select({
      keyword: productionItems.manychatKeyword,
      link: productionItems.manychatLink,
      title: productionItems.title,
    })
    .from(productionItems)
    .where(
      sql`${productionItems.manychatKeyword} IS NOT NULL AND ${productionItems.manychatLink} IS NOT NULL`
    );

  // Exact match wins.
  const exact = candidates.find((c) => c.keyword === normalized);
  if (exact && exact.link) {
    return NextResponse.json<ManychatLookupResponse>({
      found: "Yes",
      link: exact.link,
      post_title: exact.title ?? "",
    });
  }

  // Word-boundary contains: comment "send me guide saas pls" → keyword "guide saas".
  for (const c of candidates) {
    if (!c.keyword || !c.link) continue;
    const escaped = c.keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(normalized)) {
      return NextResponse.json<ManychatLookupResponse>({
        found: "Yes",
        link: c.link,
        post_title: c.title ?? "",
      });
    }
  }

  return NextResponse.json(NOT_FOUND);
}
