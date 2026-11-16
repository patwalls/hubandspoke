import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentComments, users } from "@/lib/db/schema";
import { pickDeliveryLink, type DeliveryLink, type LinkComment } from "./delivery-link";

// The DB side of lib/production/delivery-link: the open comments with a link
// on these posts (60 days back), each post's link picked from the ones left
// since it entered its status. Shared by the In Production list (Review
// rows) and the content page's Review chip, so both show the same link.
export async function loadDeliveryLinks(
  items: readonly { id: string; statusSince: Date | null }[],
): Promise<Map<string, DeliveryLink>> {
  const out = new Map<string, DeliveryLink>();
  if (items.length === 0) return out;
  const linkRows = await db
    .select({
      contentItemId: contentComments.contentItemId,
      at: contentComments.createdAt,
      body: contentComments.body,
      userName: users.name,
      authorName: contentComments.authorName,
    })
    .from(contentComments)
    .leftJoin(users, eq(users.id, contentComments.userId))
    .where(
      and(
        inArray(contentComments.contentItemId, items.map((i) => i.id)),
        isNull(contentComments.resolvedAt),
        sql`${contentComments.body} ~* 'https?://'`,
        gte(contentComments.createdAt, sql`now() - interval '60 days'`),
      ),
    );
  const byItem = new Map<string, LinkComment[]>();
  for (const c of linkRows) {
    const name = c.userName ?? c.authorName;
    const list = byItem.get(c.contentItemId) ?? [];
    list.push({ body: c.body, at: new Date(c.at), by: name ? name.trim().split(/\s+/)[0] : null });
    byItem.set(c.contentItemId, list);
  }
  for (const item of items) {
    const link = pickDeliveryLink(byItem.get(item.id) ?? [], item.statusSince);
    if (link) out.set(item.id, link);
  }
  return out;
}
