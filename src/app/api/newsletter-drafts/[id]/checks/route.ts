import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { checkLinks, collectUrls, findIssues } from "@/lib/services/newsletter-drafter/checks";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Pre-send checks: content issues + every link and image fetched (bounded). No AI. */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const draft = await getNewsletterDraft(id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!draft.template) return NextResponse.json({ error: "No template" }, { status: 409 });
  const content = findIssues({
    template: draft.template,
    sections: draft.sections,
    subject: draft.subject,
    previewText: draft.previewText,
    specialCopy: draft.specialCopy,
    specialCopyFrom: draft.specialSource?.copyFrom ?? null,
    specialMode: draft.specialMode,
    screenshots: draft.screenshots,
  });
  const links = await checkLinks(collectUrls(draft.sections));
  return NextResponse.json({ checks: [...content, ...links] });
}
