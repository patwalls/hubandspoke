import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, productionItems } from "@/lib/db/schema";

/**
 * A brand's Ready To Publish items, for the Publish screen
 * (`/[brand]/publish`): everything an editor still has to post somewhere and
 * then paste the live link back for. Oldest-waiting first.
 */
export interface ReadyToPublishItem {
  id: string;
  title: string | null;
  hook: string | null;
  postType: string | null;
  sourceType: string;
  accountHandle: string | null;
  readySince: string | null;
}

export async function getReadyToPublish(brand: string): Promise<ReadyToPublishItem[]> {
  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      hook: productionItems.hook,
      postType: productionItems.postType,
      sourceType: productionItems.sourceType,
      accountHandle: accounts.handle,
      updatedAt: productionItems.updatedAt,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(productionItems.accountId, accounts.id))
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.status, "Ready To Publish"),
        isNull(productionItems.deletedAt),
      ),
    )
    .orderBy(asc(productionItems.updatedAt))
    .limit(200);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    hook: r.hook,
    postType: r.postType,
    sourceType: r.sourceType,
    accountHandle: r.accountHandle,
    readySince: r.updatedAt ? r.updatedAt.toISOString() : null,
  }));
}
