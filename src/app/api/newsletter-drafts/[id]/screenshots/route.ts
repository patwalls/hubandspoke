import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFeature } from "@/lib/auth-guards";
import { chooseScreenshot, grabScreenshotAt, listScreenshotFrames, requestScreenshotFrames } from "@/lib/services/newsletter-drafter/screenshots";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Frames grabbed for the draft's screenshot placeholders, the picks, and each placeholder's video (for the scrubber). */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const r = await listScreenshotFrames(id);
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(r);
}

/**
 * Frames for a placeholder ({ markKey, sec }): three candidates around `sec`,
 * or with `exact` (the scrubber's "Use this frame") that one moment, picked.
 * Free: runs on our worker (ffmpeg), no AI.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const parsed = z
    .object({ markKey: z.string().min(1).max(200), sec: z.number().min(0).max(6 * 3600), exact: z.boolean().optional() })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { markKey, sec, exact } = parsed.data;
  const r = exact ? await grabScreenshotAt(id, markKey, sec) : await requestScreenshotFrames(id, markKey, sec);
  if ("error" in r) return NextResponse.json(r, { status: 400 });
  return NextResponse.json(Array.isArray(r) ? { frames: r } : r, { status: 202 });
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
