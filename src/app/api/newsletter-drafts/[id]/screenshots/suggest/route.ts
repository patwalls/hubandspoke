import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFeature } from "@/lib/auth-guards";
import { suggestStepMoment } from "@/lib/services/newsletter-drafter/screenshots";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The editor's "+ Add screenshot" under a step ({ sectionKey, step }): when
 * the step happens in the section's video, and a caption. One Haiku call
 * (paid, ~$0.003). Fail-soft: `{ sec: null }` lets the editor add a
 * placeholder to pick by hand.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const parsed = z.object({ sectionKey: z.string().min(1).max(100), step: z.string().min(1).max(4000) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const r = await suggestStepMoment(id, parsed.data.sectionKey, parsed.data.step);
  return NextResponse.json(r.ok ? { sec: r.sec, label: r.label } : { sec: null, label: null, failure: r.failure });
}
