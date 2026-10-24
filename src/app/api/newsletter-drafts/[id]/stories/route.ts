import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";
import { listStoryOptions } from "@/lib/services/newsletter-drafter/story-search";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Find new story: `?q=` searches the brand's videos and case studies; no query = recommendations. */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const draft = await getNewsletterDraft(id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const q = request.nextUrl.searchParams.get("q");
  const stories = await listStoryOptions({ brand: draft.brand, formatName: draft.formatName, draftId: draft.id, sendDate: draft.sendDate, sections: draft.sections, q: q?.slice(0, 100) });
  return NextResponse.json({ stories });
}
