import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { stalePush } from "@/lib/services/newsletter-drafter/push-state";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * "Update in beehiiv": replace the content of the draft post this newsletter
 * was pushed to with the email as it is now. The worker task does the
 * beehiiv calls (and refuses a post that was sent, scheduled or edited by
 * hand there — `force: true` overrides the last one); this only marks the
 * row pending and enqueues. Nothing here or in the task can publish or schedule.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const { force } = ((await request.json().catch(() => ({}))) ?? {}) as { force?: boolean };
  const [row] = await db
    .select({ status: newsletterDrafts.status, beehiivPostId: newsletterDrafts.beehiivPostId, beehiivStatus: newsletterDrafts.beehiivStatus, updatedAt: newsletterDrafts.updatedAt })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "ready") return NextResponse.json({ error: "Draft isn't ready yet" }, { status: 409 });
  if (!row.beehiivPostId) return NextResponse.json({ error: "No beehiiv draft to update yet — create one first" }, { status: 409 });
  if (row.beehiivStatus === "pending" && !stalePush(row.beehiivStatus, row.updatedAt)) return NextResponse.json({ ok: true });

  await db
    .update(newsletterDrafts)
    .set({ beehiivStatus: "pending", beehiivError: null, updatedAt: new Date() })
    .where(eq(newsletterDrafts.id, id));
  await enqueue("beehiiv-newsletter-update-draft", { newsletterDraftId: id, force: force === true }, {
    jobKey: `beehiiv-newsletter-update-draft:${id}`,
    maxAttempts: 1,
  });
  return NextResponse.json({ ok: true }, { status: 202 });
}
