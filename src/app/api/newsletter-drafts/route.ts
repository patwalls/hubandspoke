import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFeature } from "@/lib/auth-guards";
import { enqueue } from "@/jobs/enqueue";
import {
  createNewsletterDraft,
  listNewsletterDrafts,
  listNewsletterFormats,
} from "@/lib/services/newsletter-drafter/queries";

/** The brand's newsletter formats + its recent drafts (feature flag `newsletterDrafter`). */
export async function GET(request: NextRequest) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const brand = request.nextUrl.searchParams.get("brand");
  if (!brand) return NextResponse.json({ error: "brand is required" }, { status: 400 });
  const [formats, drafts] = await Promise.all([listNewsletterFormats(brand), listNewsletterDrafts(brand)]);
  return NextResponse.json({ formats, drafts });
}

const CreateBody = z.object({
  formatId: z.string().uuid(),
  days: z.number().int().min(1).max(31).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  sendDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  sourceItemId: z.string().uuid().nullable().optional(),
});

/** Start a draft: insert a `drafting` row and enqueue the agent run. */
export async function POST(request: NextRequest) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "formatId is required" }, { status: 400 });
  const created = await createNewsletterDraft({
    formatId: parsed.data.formatId,
    days: parsed.data.days,
    notes: parsed.data.notes,
    sendDate: parsed.data.sendDate,
    sourceItemId: parsed.data.sourceItemId,
    userId: (guard.session.user.id as string | undefined) ?? null,
  });
  if (!created) return NextResponse.json({ error: "Format not found" }, { status: 404 });
  if ("error" in created) return NextResponse.json({ error: created.error }, { status: 400 });
  // Two attempts: the retry only does work after a deploy abort (the row is
  // still `drafting`). A real failure marks the row `failed` first, so the
  // retry is a no-op instead of a second paid Opus run.
  await enqueue("newsletter-draft", { newsletterDraftId: created.id }, {
    jobKey: `newsletter-draft:${created.id}`,
    maxAttempts: 2,
  });
  return NextResponse.json({ id: created.id }, { status: 201 });
}
