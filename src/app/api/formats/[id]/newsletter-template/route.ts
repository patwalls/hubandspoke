import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfFormat } from "@/lib/brand-access";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { emailEditUrl } from "@/lib/hubspot-marketing-email";
import { templateChangeProblem, newsletterTemplateSchema, parseNewsletterTemplate, templateFor } from "@/lib/newsletter-template";
import { brandHasCaseStudies, singleVideoSourceNote } from "@/lib/services/newsletter-drafter/format-config";

/** What the editor needs for the Story settings: roundup vs one-video, and whether case studies exist for the brand. */
function storyContext(f: { name: string; brand: string | null }) {
  return {
    singleVideoNote: singleVideoSourceNote(f.name),
    caseStudies: brandHasCaseStudies(f.brand ?? ""),
  };
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function load(id: string) {
  const [f] = await db
    .select({ name: formats.name, brand: formats.brand, saved: formats.newsletterTemplate })
    .from(formats)
    .where(eq(formats.id, id))
    .limit(1);
  return f ?? null;
}

/** The format's newsletter template: saved, else the built-in default (isDefault: true), else null. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const f = await load(id);
  if (!f) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const template = templateFor(f.name, f.saved);
  return NextResponse.json({
    template,
    isDefault: !parseNewsletterTemplate(f.saved),
    /** Where the HubSpot-owned parts (masthead, course names, colors, footer) are changed. */
    hubspotTemplateUrl: template?.hubspot ? emailEditUrl(template.hubspot.templateEmailId) : null,
    ...storyContext(f),
  });
}

/** Save the format's template (validated). Applies to the next draft / section regenerate. Only a template admin can repoint the HubSpot template email. */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfFormat(id));
  if (brandGuard.response) return brandGuard.response;
  const parsed = newsletterTemplateSchema.safeParse((await request.json().catch(() => null))?.template);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "template"}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const f = await load(id);
  if (!f) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const current = templateFor(f.name, f.saved);
  const problem = current && !isFeatureEnabled("newsletterTemplateAdmin", guard.session.user) ? templateChangeProblem(current, parsed.data) : null;
  if (problem) return NextResponse.json({ error: problem }, { status: 403 });
  await db.update(formats).set({ newsletterTemplate: parsed.data }).where(eq(formats.id, id));
  return NextResponse.json({ template: parsed.data, isDefault: false });
}

/** Reset to the built-in default. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfFormat(id));
  if (brandGuard.response) return brandGuard.response;
  const [row] = await db.update(formats).set({ newsletterTemplate: null }).where(eq(formats.id, id)).returning({ name: formats.name });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ template: templateFor(row.name, null), isDefault: true });
}
