import { NextRequest, NextResponse } from "next/server";
import {
  findKeywordMatch,
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
 * Legacy HTTP shim around `findKeywordMatch` for the ManyChat External Request
 * action. The Meta Graph API direct path (/api/instagram/webhook) calls
 * `findKeywordMatch` directly. Kept during the ManyChat → Meta migration so
 * the existing automation doesn't hard-break; will be removed in a follow-up.
 *
 * Headers:  x-manychat-secret: $MANYCHAT_WEBHOOK_SECRET
 * Body:     { "comment_text": "<text>" }
 * Response: { found: "Yes"|"No", link, post_title } — always 2xx so the
 *           ManyChat condition step has a value to branch on. 401 on bad
 *           secret.
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
    return NextResponse.json(NOT_FOUND);
  }

  const match = await findKeywordMatch(commentText);
  if (!match) return NextResponse.json(NOT_FOUND);

  return NextResponse.json<ManychatLookupResponse>({
    found: "Yes",
    link: match.link,
    post_title: match.post_title,
  });
}
