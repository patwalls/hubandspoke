import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { BRANDS } from "@/lib/config/brands";
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
  const brandConfig = BRANDS.find((b) => b.slug === brand);

  if (!brandConfig) {
    notFound();
  }

  return <FormatDetail brand={brand} formatId={formatId} />;
}
