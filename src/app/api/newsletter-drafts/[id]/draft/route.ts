import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfNewsletterDraft } from "@/lib/brand-access";
import { enqueue } from "@/jobs/enqueue";
import { NEWSLETTER_START_DELAY_MS } from "@/lib/services/newsletter-drafter/format-config";
import { startEditionDraft } from "@/lib/services/newsletter-drafter/queries";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z
  .object({
    notes: z.string().max(4000).nullable().optional(),
    /** The pillar video (null = a roundup the drafter assembles); omitted keeps the row's. */
    sourceItemId: z.string().uuid().nullable().optional(),
  })
  .optional();

/**
 * Draft (or redraft) a slot: flip it to `drafting` and enqueue the agent run.
 * The queue's start-a-newsletter dialog (pillar + angle) and the editor's
 * Draft / Redraft / Try again buttons call this (opening a slot does NOT).
 * One paid model run per call; it waits NEWSLETTER_START_DELAY_MS in the
 * queue so Cancel (`…/cancel`) right after a mis-click is free.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfNewsletterDraft(id));
  if (brandGuard.response) return brandGuard.response;
  const parsed = Body.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const started = await startEditionDraft({
    id,
    notes: parsed.data?.notes,
    sourceItemId: parsed.data?.sourceItemId,
    userId: (guard.session.user.id as string | undefined) ?? null,
  });
  if ("error" in started) return NextResponse.json({ error: started.error }, { status: started.status });
  // Two attempts: the retry only does work after a deploy abort; a real
  // failure marks the row `failed` first, so the retry is a no-op.
  await enqueue("newsletter-draft", { newsletterDraftId: id }, {
    jobKey: `newsletter-draft:${id}`,
    maxAttempts: 2,
    runAt: new Date(Date.now() + NEWSLETTER_START_DELAY_MS),
  });
  return NextResponse.json({ ok: true }, { status: 202 });
}
