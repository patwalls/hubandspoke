import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";

interface RouteContext {
  params: Promise<{ id: string; key: string }>;
}

/**
 * Regenerate one section on the worker (optionally with the editor's
 * instruction), or with `newStory: true` swap it to a different story that
 * this newsletter hasn't run recently. The editor polls the draft.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id, key } = await context.params;
  const parsed = z.object({ instruction: z.string().max(1000).nullable().optional(), newStory: z.boolean().optional() }).safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const draft = await getNewsletterDraft(id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (draft.status !== "ready") return NextResponse.json({ error: "The draft isn't ready" }, { status: 409 });
  if (!draft.template?.sections.some((s) => s.key === key)) return NextResponse.json({ error: "Unknown section" }, { status: 400 });
  if (draft.regenerating.includes(key)) return NextResponse.json({ ok: true });
  await db
    .update(newsletterDrafts)
    .set({ regenerating: sql`${newsletterDrafts.regenerating} || ${JSON.stringify([key])}::jsonb`, error: null, updatedAt: new Date() })
    .where(and(eq(newsletterDrafts.id, id), eq(newsletterDrafts.status, "ready")));
  await enqueue(
    "newsletter-section-regenerate",
    { newsletterDraftId: id, sectionKey: key, instruction: parsed.data.instruction?.trim() || null, newStory: !!parsed.data.newStory },
    { jobKey: `newsletter-section:${id}:${key}`, maxAttempts: 1 },
  );
  return NextResponse.json({ ok: true }, { status: 202 });
}
