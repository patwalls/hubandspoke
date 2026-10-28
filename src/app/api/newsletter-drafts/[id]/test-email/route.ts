import { NextRequest, NextResponse } from "next/server";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfNewsletterDraft } from "@/lib/brand-access";
import { sendNewsletterTestEmail } from "@/lib/email";
import { draftEmailHtml } from "@/lib/newsletter-draft-html";
import { composeIssue } from "@/lib/newsletter-template";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Send the draft to the signed-in user as a test email: the same HTML the
 * HubSpot push sends (personalization shown as samples; screenshots as
 * preview links). The recipient is ALWAYS the session's own email — there is
 * no recipient field, so a test can never reach anyone else.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const to = guard.session.user.email;
  if (!to) return NextResponse.json({ error: "Your account has no email address" }, { status: 400 });
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfNewsletterDraft(id));
  if (brandGuard.response) return brandGuard.response;
  const draft = await getNewsletterDraft(id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (draft.status !== "ready" || !draft.template) return NextResponse.json({ error: "The draft isn't ready" }, { status: 409 });
  const sponsor = draft.specialCopy ? { copy: draft.specialCopy, landingUrl: draft.specialSource?.landingUrl ?? null } : null;
  const html = draftEmailHtml(
    draft,
    `Test send from Hub & Spoke. ${draft.template.beehiiv ? "beehiiv" : "HubSpot"} adds the real footer (unsubscribe link, address) when it sends.`,
  )!;
  try {
    await sendNewsletterTestEmail({ to, subject: draft.subject || "(no subject)", html, text: composeIssue(draft.template, draft.sections, sponsor) });
  } catch (err) {
    return NextResponse.json({ error: `Couldn't send: ${(err as Error).message}` }, { status: 502 });
  }
  return NextResponse.json({ sentTo: to });
}
