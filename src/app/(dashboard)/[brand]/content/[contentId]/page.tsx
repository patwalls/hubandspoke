import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getAccounts } from "@/lib/db/accounts";
import { auth } from "@/lib/auth";
import { ContentDetail } from "@/components/dashboard/content-detail";

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
  const accountRows = await getAccounts();
  const accounts = accountRows.map((a) => ({
    id: a.id,
    brandSlug: a.brandSlug,
    brandLabel: a.brandLabel,
    platform: a.platform,
    handle: a.handle,
    displayName: a.displayName,
    avatarUrl: a.avatarUrl,
    isActive: a.isActive,
  }));

  const session = await auth();
  const isAdmin = session?.user?.role === "admin";
  const shortLinksBaseUrl = process.env.SHORT_LINKS_BASE_URL ?? "https://go.starterstory.com";

  return (
    <ContentDetail
      brand={brand}
      contentId={contentId}
      accounts={accounts}
      isAdmin={isAdmin}
      shortLinksBaseUrl={shortLinksBaseUrl}
    />
  );
}
