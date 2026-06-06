import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import {
  createShortLink,
  updateShortLink,
  getShortLink,
  findShortLinksByContent,
  ShortLinksApiError,
} from "@/lib/services/short-links";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const BASE_URL =
  process.env.SHORT_LINKS_BASE_URL ?? "https://go.starterstory.com";

/**
 * POST /api/production-items/[id]/dm-keyword  { keywordSlug, destinationUrl }
 *
 * Wires an Instagram post's ManyChat DM keyword into per-post tracking via a
 * go→go chain:
 *
 *   go/<keywordSlug>  →  go/<per-post slug>  →  <destinationUrl>
 *
 * The keyword link is STABLE and reused across posts (a ManyChat API limitation
 * — the keyword→link mapping can't rotate per post). So instead of pointing the
 * keyword link straight at the destination, we point it at the post's OWN
 * tracked link (content_external_id = this item). That per-post link carries the
 * destination + utm, so its clicks/leads attribute to THIS post while the
 * keyword is pointed at it.
 *
 * Returns the resolved chain. The caller still persists shortLinkSlug =
 * keywordSlug on the item (the keyword is what the dashboard chip shows).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    keywordSlug?: unknown;
    destinationUrl?: unknown;
  };
  const keywordSlug = String(body.keywordSlug ?? "").trim().toLowerCase();
  const destinationUrl = String(body.destinationUrl ?? "").trim();

  if (!keywordSlug || !/^[a-z0-9_-]+$/.test(keywordSlug)) {
    return NextResponse.json({ error: "Invalid keyword slug" }, { status: 400 });
  }
  if (!/^https:\/\//i.test(destinationUrl)) {
    return NextResponse.json(
      { error: "destinationUrl must be an https:// URL" },
      { status: 400 },
    );
  }

  const [item] = await db
    .select({ id: productionItems.id, utmCampaign: productionItems.utmCampaign })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  try {
    // 1) Ensure the per-post tracked link (carries the real destination + utm).
    const perPostSlug = await ensurePerPostLink({
      itemId: id,
      utmCampaign: item.utmCampaign ?? null,
      destinationUrl,
    });

    // 2) Point the stable keyword link at the per-post go URL (go→go chain).
    const perPostGoUrl = `${BASE_URL}/${perPostSlug}`;
    const existingKeyword = await getShortLink(keywordSlug);
    if (existingKeyword) {
      await updateShortLink(keywordSlug, {
        destinationUrl: perPostGoUrl,
        tag: "dm",
        archived: false,
      });
    } else {
      await createShortLink({
        slug: keywordSlug,
        destinationUrl: perPostGoUrl,
        tag: "dm",
      });
    }

    return NextResponse.json({
      keywordSlug,
      perPostSlug,
      perPostGoUrl,
      destinationUrl,
    });
  } catch (err) {
    if (err instanceof ShortLinksApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("dm-keyword chain failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// Find-or-create the per-post tracked link (content_external_id = itemId),
// updating its destination. Returns the slug.
async function ensurePerPostLink(args: {
  itemId: string;
  utmCampaign: string | null;
  destinationUrl: string;
}): Promise<string> {
  // Reuse the item's existing per-post link if one was already minted (prefer
  // a non-keyword, non-archived link). The keyword link is tag "dm"; skip it.
  const existing = (await findShortLinksByContent(args.itemId)).filter(
    (l) => l.tag !== "dm",
  );
  const reuse = existing.find((l) => !l.archived) ?? existing[0];

  if (reuse) {
    await updateShortLink(reuse.slug, {
      destinationUrl: args.destinationUrl,
      archived: false,
      contentSource: "hubandspoke",
      contentExternalId: args.itemId,
      channel: "instagram",
      utmCampaign: args.utmCampaign,
    });
    return reuse.slug;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = `cta-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    try {
      await createShortLink({
        slug,
        destinationUrl: args.destinationUrl,
        tag: "ig-cta",
        contentSource: "hubandspoke",
        contentExternalId: args.itemId,
        channel: "instagram",
        utmCampaign: args.utmCampaign,
      });
      return slug;
    } catch (err) {
      if (err instanceof ShortLinksApiError && err.status === 409) continue;
      throw err;
    }
  }
  throw new Error("dm-keyword: could not mint a unique per-post slug");
}
