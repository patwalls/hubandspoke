import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Create the draft as an UNSENT DRAFT post in beehiiv (Futurepedia). The
 * worker task does the beehiiv calls; this only marks the row pending and
 * enqueues. A draft that already has a post is refused, so a double click
 * never makes two posts. Nothing here or in the task can publish or schedule.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const [row] = await db
    .select({ status: newsletterDrafts.status, beehiivPostId: newsletterDrafts.beehiivPostId, beehiivStatus: newsletterDrafts.beehiivStatus })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "ready") return NextResponse.json({ error: "Draft isn't ready yet" }, { status: 409 });
  if (row.beehiivPostId) return NextResponse.json({ error: "A beehiiv draft already exists for this draft" }, { status: 409 });
  if (row.beehiivStatus === "pending") return NextResponse.json({ ok: true });

  await db
    .update(newsletterDrafts)
    .set({ beehiivStatus: "pending", beehiivError: null, updatedAt: new Date() })
    .where(eq(newsletterDrafts.id, id));
  await enqueue("beehiiv-newsletter-create-draft", { newsletterDraftId: id }, {
    jobKey: `beehiiv-newsletter-create-draft:${id}`,
    maxAttempts: 1,
  });
  return NextResponse.json({ ok: true }, { status: 202 });
}
