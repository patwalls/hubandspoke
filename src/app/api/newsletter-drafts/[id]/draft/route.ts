import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({ notes: z.string().max(4000).nullable().optional() }).optional();

/**
 * Draft (or redraft) a slot: flip it to `drafting` and enqueue the agent run.
 * Opening an undrafted slot in the editor calls this; so does Redraft. One
 * paid model run per call, so it only fires from an explicit open/click.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const parsed = Body.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const [row] = await db
    .update(newsletterDrafts)
    .set({
      status: "drafting",
      error: null,
      regenerating: [],
      ...(parsed.data?.notes !== undefined ? { notes: parsed.data.notes?.trim() || null } : {}),
      createdByUserId: (guard.session.user.id as string | undefined) ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(newsletterDrafts.id, id), inArray(newsletterDrafts.status, ["idea", "failed", "ready"])))
    .returning({ id: newsletterDrafts.id });
  if (!row) return NextResponse.json({ error: "Already drafting, or not found" }, { status: 409 });
  // Two attempts: the retry only does work after a deploy abort; a real
  // failure marks the row `failed` first, so the retry is a no-op.
  await enqueue("newsletter-draft", { newsletterDraftId: id }, { jobKey: `newsletter-draft:${id}`, maxAttempts: 2 });
  return NextResponse.json({ ok: true }, { status: 202 });
}
