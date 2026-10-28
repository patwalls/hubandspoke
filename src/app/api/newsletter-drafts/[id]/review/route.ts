import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfNewsletterDraft } from "@/lib/brand-access";
import { db } from "@/lib/db";
import { newsletterDrafts, type NewsletterReview } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Start the AI review of a ready draft on the worker (`newsletter-review`); the editor polls the draft's `review`. */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfNewsletterDraft(id));
  if (brandGuard.response) return brandGuard.response;
  const draft = await getNewsletterDraft(id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (draft.status !== "ready") return NextResponse.json({ error: "The draft isn't ready" }, { status: 409 });
  if (draft.review?.status === "running") return NextResponse.json({ ok: true });
  const review: NewsletterReview = { status: "running", revision: draft.revision, summary: null, findings: [], at: new Date().toISOString() };
  await db.update(newsletterDrafts).set({ review, updatedAt: new Date() }).where(and(eq(newsletterDrafts.id, id), eq(newsletterDrafts.status, "ready")));
  await enqueue("newsletter-review", { newsletterDraftId: id }, { jobKey: `newsletter-review:${id}`, maxAttempts: 1 });
  return NextResponse.json({ draft: await getNewsletterDraft(id) }, { status: 202 });
}

/** Mark a finding applied / dismissed (or clear the review). */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfNewsletterDraft(id));
  if (brandGuard.response) return brandGuard.response;
  const parsed = z.object({ findingId: z.string().optional(), state: z.enum(["applied", "dismissed"]).optional(), clear: z.boolean().optional() }).safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const draft = await getNewsletterDraft(id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (parsed.data.clear) {
    await db.update(newsletterDrafts).set({ review: null, updatedAt: new Date() }).where(eq(newsletterDrafts.id, id));
  } else if (draft.review && parsed.data.findingId && parsed.data.state) {
    const review: NewsletterReview = { ...draft.review, findings: draft.review.findings.map((f) => (f.id === parsed.data.findingId ? { ...f, state: parsed.data.state } : f)) };
    await db.update(newsletterDrafts).set({ review, updatedAt: new Date(), revision: sql`${newsletterDrafts.revision}` }).where(eq(newsletterDrafts.id, id));
  }
  return NextResponse.json({ draft: await getNewsletterDraft(id) });
}
