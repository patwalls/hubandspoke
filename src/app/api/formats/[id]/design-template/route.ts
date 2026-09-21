import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/auth-guards";
import { parseDesignDoc } from "@/lib/design-editor/doc";
import { isDesignPresetId } from "@/lib/design-editor/templates";
import { clearFormatTemplate, createFormatTemplateFromPreset, loadFormatTemplateById, saveFormatTemplate } from "@/lib/services/design-editor/format-template";
import { resolveImageUrls } from "@/lib/services/design-editor/session";
import { listBrandLogos } from "@/lib/services/brand-logos";
import { loadBrandChannels } from "@/lib/services/design-editor/channels";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The format's design template (stored, or the built-in preset), with
 *  browser-loadable image URLs — what the editor's template mode opens. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const t = await loadFormatTemplateById(id);
  if (!t) return NextResponse.json({ template: null });
  return NextResponse.json({ template: { doc: t.doc, source: t.source, updatedAt: t.updatedAt }, imageUrls: await resolveImageUrls(t.doc), images: await listBrandLogos(t.brand), channels: await loadBrandChannels(t.brand) });
}

/** Save the template. Body: `{ doc }`. */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { doc?: unknown };
  const parsed = parseDesignDoc(body.doc);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  await saveFormatTemplate(id, parsed.doc);
  return NextResponse.json({ ok: true });
}

/** Create (or reset) the template from a preset. Body: `{ preset }`. */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { preset?: unknown };
  if (!isDesignPresetId(body.preset)) return NextResponse.json({ error: "Unknown preset" }, { status: 400 });
  const doc = await createFormatTemplateFromPreset(id, body.preset);
  const t = await loadFormatTemplateById(id);
  return NextResponse.json({ template: { doc, source: "stored" }, imageUrls: await resolveImageUrls(doc), images: t ? await listBrandLogos(t.brand) : [] });
}

/** Remove the stored template (the format falls back to its preset, if any). */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("designEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  await clearFormatTemplate(id);
  return NextResponse.json({ ok: true });
}
