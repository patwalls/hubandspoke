import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfNewsletterDraft } from "@/lib/brand-access";
import { cancelDraftRun, cancelSectionRun } from "@/lib/services/newsletter-drafter/cancel";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({ section: z.string().min(1).max(40).optional() });

/**
 * Cancel a draft run ({}) or one section's regenerate / Find new story
 * ({ section }). Free while the run is still in its start delay; after that
 * it stops at the end of the current model step and saves nothing.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfNewsletterDraft(id));
  if (brandGuard.response) return brandGuard.response;
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const cancelled = parsed.data.section ? await cancelSectionRun(id, parsed.data.section) : await cancelDraftRun(id);
  return NextResponse.json({ ok: true, cancelled });
}
