import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { formats, newsletterTemplateProposals } from "@/lib/db/schema";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { enqueue } from "@/jobs/enqueue";
import { templateFor } from "@/lib/newsletter-template";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function latest(formatId: string) {
  const [row] = await db
    .select({
      id: newsletterTemplateProposals.id,
      status: newsletterTemplateProposals.status,
      proposal: newsletterTemplateProposals.proposal,
      rationale: newsletterTemplateProposals.rationale,
      issueCount: newsletterTemplateProposals.issueCount,
      error: newsletterTemplateProposals.error,
      createdAt: newsletterTemplateProposals.createdAt,
    })
    .from(newsletterTemplateProposals)
    .where(eq(newsletterTemplateProposals.formatId, formatId))
    .orderBy(desc(newsletterTemplateProposals.createdAt))
    .limit(1);
  return row ?? null;
}

/** The latest template proposal for the format (pending / done / failed), or null. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  return NextResponse.json({ proposal: await latest(id) });
}

/** Learn a template from the format's past issues on the worker (`newsletter-template-learn`). A locked template: admins only. */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const [f] = await db.select({ name: formats.name, saved: formats.newsletterTemplate }).from(formats).where(eq(formats.id, id)).limit(1);
  if (!f) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const current = templateFor(f.name, f.saved);
  if (!current) return NextResponse.json({ error: "This format has no newsletter template yet" }, { status: 409 });
  if (current.locked && !isFeatureEnabled("newsletterTemplateAdmin", guard.session.user)) {
    return NextResponse.json({ error: "This template is locked. Contact Sam to learn a new one." }, { status: 403 });
  }
  const cur = await latest(id);
  if (cur?.status === "pending") return NextResponse.json({ proposal: cur }, { status: 200 });
  const [row] = await db
    .insert(newsletterTemplateProposals)
    .values({ formatId: id, createdByUserId: (guard.session.user.id as string | undefined) ?? null })
    .returning({ id: newsletterTemplateProposals.id });
  await enqueue("newsletter-template-learn", { proposalId: row.id }, { jobKey: `newsletter-template-learn:${row.id}`, maxAttempts: 1 });
  return NextResponse.json({ proposal: await latest(id) }, { status: 202 });
}

/** Discard the latest proposal. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const cur = await latest(id);
  if (cur) await db.delete(newsletterTemplateProposals).where(eq(newsletterTemplateProposals.id, cur.id));
  return NextResponse.json({ proposal: null });
}
