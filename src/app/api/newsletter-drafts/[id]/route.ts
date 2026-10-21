import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";
import { composeIssue } from "@/lib/newsletter-template";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const draft = await getNewsletterDraft(id);
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ draft });
}

const PatchBody = z
  .object({
    subject: z.string().max(200).optional(),
    previewText: z.string().max(300).optional(),
    bodyMarkdown: z.string().max(100_000).optional(),
    specialCopy: z.string().max(20_000).optional(),
    sendDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    sections: z
      .array(
        z.object({
          key: z.string().min(1).max(40),
          markdown: z.string().max(20_000),
          // Kept as-is from the loaded draft: the story the section covers + stories Find new story already offered.
          source: z
            .object({ kind: z.enum(["video", "case_study"]), key: z.string().max(300), title: z.string().max(500).nullable(), url: z.string().max(1000).nullable() })
            .nullable()
            .optional(),
          tried: z.array(z.string().max(300)).max(50).optional(),
        }),
      )
      .max(20)
      .optional(),
    notes: z.string().max(4000).nullable().optional(),
    /** The revision the editor loaded; a stale save is refused. */
    revision: z.number().int().optional(),
  })
  .strict();

/** Save the editor's edits to subject / preview text / body. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const parsed = PatchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { revision, ...fields } = parsed.data;
  const current = await getNewsletterDraft(id);
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (revision !== undefined && revision !== current.revision) {
    return NextResponse.json({ error: "This draft changed since you opened it (a regenerate finished). Reload to see it.", draft: current }, { status: 409 });
  }
  // Keep the composed body in step with the sections (it's what the HubSpot push sends).
  const sections = fields.sections ?? current.sections;
  const specialCopy = fields.specialCopy ?? current.specialCopy;
  const bodyMarkdown =
    current.template && (fields.sections || fields.specialCopy !== undefined)
      ? composeIssue(current.template, sections, specialCopy ? { copy: specialCopy, landingUrl: current.specialSource?.landingUrl ?? null } : null)
      : fields.bodyMarkdown;
  await db
    .update(newsletterDrafts)
    .set({
      ...fields,
      ...(bodyMarkdown !== undefined ? { bodyMarkdown } : {}),
      revision: sql`${newsletterDrafts.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(newsletterDrafts.id, id));
  return NextResponse.json({ draft: await getNewsletterDraft(id) });
}
