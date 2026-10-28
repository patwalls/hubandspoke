import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfNewsletterDraft } from "@/lib/brand-access";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { stalePush } from "@/lib/services/newsletter-drafter/push-state";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Create the draft as an unsent marketing email in HubSpot portal 53. The
 * worker task does the HubSpot calls; this only marks the row pending and
 * enqueues. A draft that already has an email is refused, so a double click
 * never makes two emails; a push still pending is left alone unless the
 * worker died on it (stalePush), which takes a retry.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfNewsletterDraft(id));
  if (brandGuard.response) return brandGuard.response;
  const [row] = await db
    .select({ status: newsletterDrafts.status, hubspotEmailId: newsletterDrafts.hubspotEmailId, hubspotStatus: newsletterDrafts.hubspotStatus, updatedAt: newsletterDrafts.updatedAt })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.status !== "ready") return NextResponse.json({ error: "Draft isn't ready yet" }, { status: 409 });
  if (row.hubspotEmailId) return NextResponse.json({ error: "A HubSpot email already exists for this draft" }, { status: 409 });
  if (row.hubspotStatus === "pending" && !stalePush(row.hubspotStatus, row.updatedAt)) return NextResponse.json({ ok: true });

  await db
    .update(newsletterDrafts)
    .set({ hubspotStatus: "pending", hubspotError: null, updatedAt: new Date() })
    .where(eq(newsletterDrafts.id, id));
  await enqueue("hubspot-newsletter-create-draft", { newsletterDraftId: id }, {
    jobKey: `hubspot-newsletter-create-draft:${id}`,
    maxAttempts: 1,
  });
  return NextResponse.json({ ok: true }, { status: 202 });
}
