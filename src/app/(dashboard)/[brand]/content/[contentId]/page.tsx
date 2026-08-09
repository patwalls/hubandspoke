import { notFound } from "next/navigation";
import { preload } from "react-dom";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getAccounts } from "@/lib/db/accounts";
import { getBrandStatuses } from "@/lib/db/brand-statuses";
import { ContentDetail } from "@/components/dashboard/content-detail";
import { auth } from "@/lib/auth";

interface ContentDetailPageProps {
  params: Promise<{ brand: string; contentId: string }>;
}

export async function generateMetadata({
  params,
}: ContentDetailPageProps): Promise<Metadata> {
  const { contentId } = await params;
  const [item] = await db
    .select({ title: productionItems.title })
    .from(productionItems)
    .where(eq(productionItems.id, contentId))
    .limit(1);
  return { title: item?.title || "Post" };
}

export default async function BrandContentDetailPage({
  params,
}: ContentDetailPageProps) {
  const { brand, contentId } = await params;
  const brandConfig = await fetchBrandBySlug(brand);

  if (!brandConfig) {
    notFound();
  }

  // Fetch accounts once on the server and thread through so the picker can
  // render without an extra round-trip. Keep the shape minimal — the picker
  // only needs id/brand/platform/handle/displayName.
  //
  // preload: the detail payload is fetched client-side after hydration —
  // this <link rel=preload as=fetch> makes the browser START that request
  // while the JS is still loading, cutting the serial
  // shell -> hydrate -> fetch -> render waterfall (~3s felt) down by a full
  // fetch leg. crossOrigin must match the client fetch's credentials mode
  // (content-detail.tsx uses credentials:"include") or the preload is wasted.
  preload(`/api/production-items/${contentId}`, {
    as: "fetch",
    crossOrigin: "use-credentials",
  });
  const [accountRows, statusRows, session] = await Promise.all([
    getAccounts(),
    getBrandStatuses(brand),
    auth(),
  ]);
  const isAdmin = session?.user?.role === "admin";
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

  const shortLinksBaseUrl = process.env.SHORT_LINKS_BASE_URL ?? "https://go.starterstory.com";

  return (
    <ContentDetail
      brand={brand}
      contentId={contentId}
      accounts={accounts}
      shortLinksBaseUrl={shortLinksBaseUrl}
      statuses={statuses}
      isAdmin={isAdmin}
    />
  );
}
