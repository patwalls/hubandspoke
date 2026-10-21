import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFeature } from "@/lib/auth-guards";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";
import { listSlotVideoOptions, setSlotVideo } from "@/lib/services/newsletter-drafter/slots";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Videos a How-To slot can be drafted from (both channels in its group). */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const videos = await listSlotVideoOptions(id);
  if (!videos) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ videos });
}

/** Switch the slot's source video (its format follows the video's channel). */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const parsed = z.object({ itemId: z.string().uuid() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  const r = await setSlotVideo(id, parsed.data.itemId);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ draft: await getNewsletterDraft(id) });
}
