import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";
import { suggestSubjectLines } from "@/lib/services/newsletter-drafter/subjects";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Six more subject line + preview text ideas (Sonnet, in the request); appended to the draft's options. */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const r = await suggestSubjectLines(id);
  if (!r.ok) {
    const status = r.failure === "not_found" ? 404 : r.failure === "not_ready" ? 409 : 502;
    return NextResponse.json({ error: r.failure === "llm-error" ? `Couldn't get ideas: ${r.message}` : r.failure === "not_ready" ? "The draft isn't ready" : "No new ideas came back — try again" }, { status });
  }
  return NextResponse.json({ ideas: r.ideas, draft: await getNewsletterDraft(id) });
}
