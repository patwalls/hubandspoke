import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getStatusPalette } from "@/lib/db/brand-statuses";
import { FormatDetail } from "@/components/dashboard/format-detail";

interface FormatDetailPageProps {
  params: Promise<{ brand: string; formatId: string }>;
}

export async function generateMetadata({
  params,
}: FormatDetailPageProps): Promise<Metadata> {
  const { formatId } = await params;
  const [format] = await db
    .select({ name: formats.name })
    .from(formats)
    .where(eq(formats.id, formatId))
    .limit(1);
  return { title: format?.name ? `${format.name} · Formats` : "Format" };
}

export default async function BrandFormatDetailPage({
  params,
}: FormatDetailPageProps) {
  const { brand, formatId } = await params;
  const brandConfig = await fetchBrandBySlug(brand);

  if (!brandConfig) {
    notFound();
  }

  // The status palette is a Map; serialize as a plain array for the prop
  // boundary, then the client component reconstructs the Map.
  const palette = await getStatusPalette(brand);
  const statusPalette = new Map(palette);

  return (
    <FormatDetail brand={brand} formatId={formatId} statusPalette={statusPalette} />
  );
}
