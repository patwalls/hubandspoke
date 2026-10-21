import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { formats, newsletterDrafts } from "@/lib/db/schema";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";
import { findSpecial } from "@/lib/services/newsletter-drafter/promo";
import { formatConfigFor } from "@/lib/services/newsletter-drafter/format-config";
import { getPastIssues } from "@/lib/services/newsletter-drafter/sources";
import { rewriteSpecial } from "@/lib/services/newsletter-drafter/special-rewrite";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({ action: z.enum(["verbatim", "rewrite", "refresh"]) });

/**
 * The draft's sponsored section (The Special):
 * - verbatim: restore the copy exactly as pulled from Asana
 * - rewrite:  one Haiku rewrite of the Asana copy in the newsletter's voice
 * - refresh:  re-pull the promo task for the draft's send date from Asana
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  const [row] = await db
    .select({
      brand: newsletterDrafts.brand,
      sendDate: newsletterDrafts.sendDate,
      specialOriginal: newsletterDrafts.specialOriginal,
      specialSource: newsletterDrafts.specialSource,
      formatName: formats.name,
      formatInstructions: formats.instructions,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const save = async (patch: Partial<typeof newsletterDrafts.$inferInsert>) => {
    await db.update(newsletterDrafts).set({ ...patch, updatedAt: new Date() }).where(eq(newsletterDrafts.id, id));
    return NextResponse.json({ draft: await getNewsletterDraft(id) });
  };

  if (parsed.data.action === "refresh") {
    const special = await findSpecial(row.formatName, row.sendDate);
    if (!special) return NextResponse.json({ error: "This format has no promo calendar" }, { status: 422 });
    if (!special.ok) return save({ specialError: special.error });
    return save({
      specialOriginal: special.copy,
      specialCopy: special.copy,
      specialMode: "verbatim",
      specialSource: special.source,
      specialError: null,
    });
  }

  if (!row.specialOriginal) return NextResponse.json({ error: "No promo copy on this draft" }, { status: 409 });

  if (parsed.data.action === "verbatim") {
    return save({ specialCopy: row.specialOriginal, specialMode: "verbatim" });
  }

  const result = await rewriteSpecial({
    formatName: row.formatName,
    label: formatConfigFor(row.formatName).promo?.label ?? "sponsored section",
    formatInstructions: row.formatInstructions,
    sponsorCopy: row.specialOriginal,
    landingUrl: row.specialSource?.landingUrl ?? null,
    pastIssues: await getPastIssues(row.brand, row.formatName),
  });
  if (!result.ok) return NextResponse.json({ error: `Rewrite failed: ${result.failure}` }, { status: 502 });
  return save({ specialCopy: result.copy, specialMode: "rewrite" });
}
