import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfNewsletterDraft } from "@/lib/brand-access";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";
import { applySpecialAction } from "@/lib/services/newsletter-drafter/special";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("verbatim") }),
  z.object({ action: z.literal("refresh") }),
  z.object({ action: z.literal("rewrite"), instruction: z.string().max(2000).nullish(), current: z.string().max(20000).nullish() }),
  z.object({ action: z.literal("paste"), copy: z.string().max(20000), link: z.string().max(2000).nullish(), rewrite: z.boolean().optional() }),
  z.object({ action: z.literal("link"), url: z.string().max(2000), current: z.string().max(20000) }),
  z.object({ action: z.literal("remove") }),
]);

/** The draft's ad (its sponsor section): see applySpecialAction for each action. */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfNewsletterDraft(id));
  if (brandGuard.response) return brandGuard.response;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  const result = await applySpecialAction(id, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ draft: await getNewsletterDraft(id) });
}
