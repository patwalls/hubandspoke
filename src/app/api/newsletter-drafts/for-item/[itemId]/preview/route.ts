import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { draftEmailHtml } from "@/lib/newsletter-draft-html";
import { getNewsletterDraft } from "@/lib/services/newsletter-drafter/queries";

interface RouteContext {
  params: Promise<{ itemId: string }>;
}

/**
 * The newsletter edition behind a content item, rendered as the email it
 * sends (the editor's exact preview), so the content page can show it.
 * `html` is null while the edition is still drafting or has no template.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("newsletterDrafter");
  if (guard.response) return guard.response;
  const { itemId } = await context.params;
  const [row] = await db
    .select({ id: newsletterDrafts.id })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.productionItemId, itemId))
    .limit(1);
  if (!row) return NextResponse.json({ error: "No newsletter edition for this item" }, { status: 404 });
  const draft = await getNewsletterDraft(row.id);
  if (!draft) return NextResponse.json({ error: "No newsletter edition for this item" }, { status: 404 });
  const html = draft.status === "ready" ? draftEmailHtml(draft, null) : null;
  return NextResponse.json({
    draftId: draft.id,
    status: draft.status,
    subject: draft.subject,
    previewText: draft.previewText,
    html,
  });
}
