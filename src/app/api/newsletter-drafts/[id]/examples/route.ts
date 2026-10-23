import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { sectionExamplesFor } from "@/lib/services/newsletter-drafter/exemplars";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";
import { getPastIssues } from "@/lib/services/newsletter-drafter/sources";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** How one template section read in past issues (`?section=<key>`), for "Write it like a past issue". */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const key = request.nextUrl.searchParams.get("section");
  const draft = await getNewsletterDraft(id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!key || !draft.template?.sections.some((s) => s.key === key)) return NextResponse.json({ error: "Unknown section" }, { status: 400 });
  const issues = await getPastIssues(draft.brand, draft.formatName, null, draft.template.sections.map((s) => s.heading ?? "").filter(Boolean), { limit: 10 });
  return NextResponse.json({ examples: sectionExamplesFor(issues, draft.template, key) });
}
