import { notFound } from "next/navigation";
import { BRANDS } from "@/lib/config/brands";
import { FormatDetail } from "@/components/dashboard/format-detail";

interface FormatDetailPageProps {
  params: Promise<{ brand: string; formatId: string }>;
}

export default async function BrandFormatDetailPage({
  params,
}: FormatDetailPageProps) {
  const { brand, formatId } = await params;
  const brandConfig = BRANDS.find((b) => b.slug === brand);

  if (!brandConfig) {
    notFound();
  }

  return <FormatDetail brand={brand} formatId={formatId} />;
}
