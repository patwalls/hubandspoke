import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { brandOfNewsletterDraft } from "@/lib/brand-access";
import { enqueue } from "@/jobs/enqueue";
import { NEWSLETTER_START_DELAY_MS } from "@/lib/services/newsletter-drafter/format-config";
import { startRevision } from "@/lib/services/newsletter-drafter/revise";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The editor's whole-email Revise: mark the revisable sections regenerating
 * and enqueue `newsletter-revise` with the note. The editor polls the draft
 * until `regenerating` empties; Cancel on a section stops just that one.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfNewsletterDraft(id));
  if (brandGuard.response) return brandGuard.response;
  const parsed = z.object({ note: z.string().trim().min(1).max(2000) }).safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Say what to change" }, { status: 400 });
  const keys = await startRevision(id);
  if (!keys) return NextResponse.json({ error: "The draft isn't ready" }, { status: 409 });
  await enqueue("newsletter-revise", { newsletterDraftId: id, note: parsed.data.note }, {
    jobKey: `newsletter-revise:${id}`,
    maxAttempts: 1,
    runAt: new Date(Date.now() + NEWSLETTER_START_DELAY_MS),
  });
  return NextResponse.json({ ok: true }, { status: 202 });
}
