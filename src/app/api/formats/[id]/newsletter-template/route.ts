import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { newsletterTemplateSchema, parseNewsletterTemplate, templateFor } from "@/lib/newsletter-template";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function load(id: string) {
  const [f] = await db
    .select({ name: formats.name, saved: formats.newsletterTemplate })
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
  return NextResponse.json({ template: templateFor(f.name, f.saved), isDefault: !parseNewsletterTemplate(f.saved) });
}

/** Save the format's template (validated). Applies to the next draft / section regenerate. */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const parsed = newsletterTemplateSchema.safeParse((await request.json().catch(() => null))?.template);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "template"}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const [row] = await db.update(formats).set({ newsletterTemplate: parsed.data }).where(eq(formats.id, id)).returning({ id: formats.id });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ template: parsed.data, isDefault: false });
}

/** Reset to the built-in default. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const [row] = await db.update(formats).set({ newsletterTemplate: null }).where(eq(formats.id, id)).returning({ name: formats.name });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ template: templateFor(row.name, null), isDefault: true });
}
