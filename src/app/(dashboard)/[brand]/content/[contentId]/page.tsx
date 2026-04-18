import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { BRANDS } from "@/lib/config/brands";
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
  const brandConfig = BRANDS.find((b) => b.slug === brand);

  if (!brandConfig) {
    notFound();
  }

  return <ContentDetail brand={brand} contentId={contentId} />;
}
