import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFeature } from "@/lib/auth-guards";
import { chooseScreenshot, listScreenshotFrames, requestScreenshotFrames } from "@/lib/services/newsletter-drafter/screenshots";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Frames grabbed from the draft's video for its screenshot placeholders, and the picks. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const r = await listScreenshotFrames(id);
  if (!r) return NextResponse.json({ error: "This draft has no source video" }, { status: 404 });
  return NextResponse.json(r);
}

/** Grab candidate frames around a placeholder's moment ({ sec }). Free: runs on our worker (ffmpeg), no AI. */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const parsed = z.object({ sec: z.number().min(0).max(6 * 3600) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const frames = await requestScreenshotFrames(id, parsed.data.sec);
  if (!frames) return NextResponse.json({ error: "This draft has no source video" }, { status: 404 });
  return NextResponse.json({ frames }, { status: 202 });
}

/** Pick (or clear) the frame for a placeholder: { markKey, frameId | null }. */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const parsed = z.object({ markKey: z.string().min(1).max(200), frameId: z.string().uuid().nullable() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const r = await chooseScreenshot(id, parsed.data.markKey, parsed.data.frameId);
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  return NextResponse.json(r);
}
