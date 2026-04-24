import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { and, isNotNull, isNull, desc } from "drizzle-orm";
import { SyncErrorsTable } from "@/components/settings/sync-errors-table";

export const metadata: Metadata = { title: "Sync errors · Settings" };
export const dynamic = "force-dynamic";

export default async function SyncErrorsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      brand: productionItems.brand,
      platform: productionItems.platform,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      lastPerformanceSyncAt: productionItems.lastPerformanceSyncAt,
      lastPerformanceSyncError: productionItems.lastPerformanceSyncError,
    })
    .from(productionItems)
    .where(
      and(
        isNotNull(productionItems.lastPerformanceSyncError),
        isNotNull(productionItems.lastPerformanceSyncAt),
        isNull(productionItems.deletedAt)
      )
    )
    .orderBy(desc(productionItems.lastPerformanceSyncAt));

  const items = rows.map((r) => ({
    id: r.id,
    title: r.title,
    brand: r.brand,
    platform: (r.platform as string[] | null) ?? [],
    url: r.publishedLink || r.youtubeUrl || null,
    lastPerformanceSyncAt: r.lastPerformanceSyncAt?.toISOString() ?? null,
    lastPerformanceSyncError: r.lastPerformanceSyncError ?? "",
  }));

  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <h2 className="text-base font-semibold text-foreground">Sync errors</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Items whose last performance sync failed. Fix the URL on the content
          detail page, then click Retry.
        </p>
      </div>
      <SyncErrorsTable items={items} />
    </div>
  );
}
