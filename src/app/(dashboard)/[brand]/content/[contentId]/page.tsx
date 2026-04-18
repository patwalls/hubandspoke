import { notFound } from "next/navigation";
import { BRANDS } from "@/lib/config/brands";
import { ContentDetail } from "@/components/dashboard/content-detail";

interface ContentDetailPageProps {
  params: Promise<{ brand: string; contentId: string }>;
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
