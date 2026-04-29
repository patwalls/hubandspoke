import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { getAccounts } from "@/lib/db/accounts";
import { getBrandStatuses } from "@/lib/db/brand-statuses";
import { ContentDetail } from "@/components/dashboard/content-detail";

interface AllContentDetailPageProps {
  params: Promise<{ contentId: string }>;
}

export async function generateMetadata({
  params,
}: AllContentDetailPageProps): Promise<Metadata> {
  const { contentId } = await params;
  const [item] = await db
    .select({ title: productionItems.title })
    .from(productionItems)
    .where(eq(productionItems.id, contentId))
    .limit(1);
  return { title: item?.title || "Post" };
}

export default async function AllContentDetailPage({
  params,
}: AllContentDetailPageProps) {
  const { contentId } = await params;

  // Each item knows its own brand. Look it up here so the detail component
  // can run with the per-brand wiring (cross-post target picker, format
  // links, "back to content" — all are sensibly brand-scoped). Side-effect:
  // "Back" goes to the per-brand content list, not /all/content. Acceptable
  // for v1 — the detail view is inherently brand-contextual.
  const [item] = await db
    .select({ brand: productionItems.brand })
    .from(productionItems)
    .where(eq(productionItems.id, contentId))
    .limit(1);
  if (!item) {
    notFound();
  }

  const [accountRows, statusRows] = await Promise.all([
    getAccounts(),
    getBrandStatuses(item.brand),
  ]);
  const accounts = accountRows.map((a) => ({
    id: a.id,
    brandSlug: a.brandSlug,
    brandLabel: a.brandLabel,
    platform: a.platform,
    handle: a.handle,
    displayName: a.displayName,
    avatarUrl: a.avatarUrl,
    isActive: a.isActive,
    syncedFromNotion: a.syncedFromNotion,
  }));
  const statuses = statusRows.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    position: s.position,
  }));

  const shortLinksBaseUrl =
    process.env.SHORT_LINKS_BASE_URL ?? "https://go.starterstory.com";

  return (
    <ContentDetail
      brand={item.brand}
      contentId={contentId}
      accounts={accounts}
      shortLinksBaseUrl={shortLinksBaseUrl}
      statuses={statuses}
    />
  );
}
