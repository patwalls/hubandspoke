import { Suspense } from "react";
import { notFound } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { QueueView } from "@/components/dashboard/queue-view";
import { getClippableFormats, getFormatNameToIdMap } from "@/lib/db/formats";
import { getProductionReportCached } from "@/lib/services/production-report";
import { auth } from "@/lib/auth";

interface BrandQueuePageProps {
  params: Promise<{ brand: string }>;
}

export async function generateMetadata({
  params,
}: BrandQueuePageProps): Promise<Metadata> {
  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  return {
    title: brandConfig ? `Queue · ${brandConfig.label}` : "Queue",
  };
}

export default async function BrandQueuePage({
  params,
}: BrandQueuePageProps) {
  const { brand } = await params;
  const [brandConfig, session, clippableFormats, formatNameToId, report] =
    await Promise.all([
      fetchBrandBySlug(brand),
      auth(),
      getClippableFormats(brand),
      getFormatNameToIdMap(brand),
      // SSR the queue's primary payload (60s-cached) so the All tab paints
      // with data — the client previously fetched this after hydration and
      // it measured 1.5-2.7s. Fail-open to the client fetch, loudly.
      getProductionReportCached(brand, false).catch((err) => {
        Sentry.captureException(err, { tags: { surface: "queue-ssr", brand } });
        return null;
      }),
    ]);
  // JSON-roundtrip: byte-identical to the fetch path (dates -> ISO strings).
  const initialItems = report
    ? (JSON.parse(JSON.stringify(report.items)) as Parameters<
        typeof QueueView
      >[0]["initialItems"])
    : undefined;

  if (!brandConfig) {
    notFound();
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <QueueView
        key={brand}
        initialItems={initialItems}
        brand={brand}
        initialSource="all"
        clippableFormats={clippableFormats.map((f) => ({
          id: f.id,
          name: f.name,
          slug: f.slug,
        }))}
        formatNameToId={formatNameToId}
        isAdmin={session?.user?.role === "admin"}
      />
    </Suspense>
  );
}
