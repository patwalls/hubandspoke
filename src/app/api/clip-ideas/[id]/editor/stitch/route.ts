import { NextRequest, NextResponse } from "next/server";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfClipIdea } from "@/lib/brand-access";
import { enqueue } from "@/jobs/enqueue";
import { needsStitchSuggest } from "@/lib/clip-stitch";
import { sectionForClipIdea } from "@/lib/services/clip-stitch-suggest";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Clip stitching M3: "Lines to stitch in" for an idea whose section predates
 * section-picker v2. POST asks the worker to find them (once per section —
 * the result is stored on the section); GET is what the editor polls.
 * Both answer `{ pending, moments }`.
 */
async function guard(context: RouteContext) {
  const g = await requireFeature("clipEditor");
  if (g.response) return { response: g.response };
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfClipIdea(id));
  if (brandGuard.response) return { response: brandGuard.response };
  return { id };
}

async function state(id: string) {
  const section = await sectionForClipIdea(id);
  return {
    section,
    pending: needsStitchSuggest(section),
    moments: section?.killedAt ? [] : (section?.supportingMoments ?? []),
  };
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const g = await guard(context);
  if (g.response) return g.response;
  const { pending, moments } = await state(g.id);
  return NextResponse.json({ pending, moments });
}

export async function POST(_request: NextRequest, context: RouteContext) {
  const g = await guard(context);
  if (g.response) return g.response;
  const { section, pending, moments } = await state(g.id);
  if (pending && section) {
    await enqueue(
      "clip-section-stitch",
      { clipSectionId: section.id },
      { jobKey: `clip-section-stitch:${section.id}`, maxAttempts: 3 },
    );
  }
  return NextResponse.json({ pending, moments });
}
