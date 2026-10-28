import { NextRequest, NextResponse } from "next/server";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfNewsletterDraft } from "@/lib/brand-access";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";
import { proofreadSections } from "@/lib/services/newsletter-drafter/proofread";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Exact typo/grammar fixes for the draft's sections (Sonnet). The editor applies them to its text and saves as usual. */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfNewsletterDraft(id));
  if (brandGuard.response) return brandGuard.response;
  const draft = await getNewsletterDraft(id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (draft.status !== "ready" || !draft.template) return NextResponse.json({ error: "The draft isn't ready" }, { status: 409 });
  const names = Object.fromEntries(draft.template.sections.map((s) => [s.key, s.heading ?? ""]));
  const r = await proofreadSections({ sections: draft.sections, sectionNames: names, subject: draft.subject, styleNotes: draft.template.styleNotes });
  if (!r.ok) return NextResponse.json({ error: r.failure === "llm-error" ? `Couldn't proofread: ${r.message}` : "Nothing came back — try again" }, { status: 502 });
  return NextResponse.json({ fixes: r.fixes });
}
