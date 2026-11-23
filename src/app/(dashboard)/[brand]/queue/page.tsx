import { Suspense } from "react";
import { notFound } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { QueueView } from "@/components/dashboard/queue-view";
import { getClippableFormats, getFormatNameToIdMap } from "@/lib/db/formats";
import { getProductionReportFast } from "@/lib/services/production-report";
import { auth } from "@/lib/auth";
import { listNewsletterFormats } from "@/lib/services/newsletter-drafter/queries";
import { isAdminNow } from "@/lib/brand-access";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { parseQueueAge } from "@/lib/queue-age";

interface BrandQueuePageProps {
  params: Promise<{ brand: string }>;
  searchParams?: Promise<{ age?: string | string[] }>;
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
  searchParams,
}: BrandQueuePageProps) {
  const { brand } = await params;
  const rawAge = (await searchParams)?.age;
  const session = await auth();
  // The default "Last 30 days" view (flag queueRecentOnly) SSRs only recent
  // Idea rows + counts of the older ones (services/production-report.ts).
  const recentOnly =
    parseQueueAge(typeof rawAge === "string" ? rawAge : null) === "recent" &&
    isFeatureEnabled("queueAge", session?.user) &&
    isFeatureEnabled("queueRecentOnly", session?.user);
  const [brandConfig, clippableFormats, formatNameToId, report, newsletterFormats] =
    await Promise.all([
      fetchBrandBySlug(brand),
      getClippableFormats(brand),
      getFormatNameToIdMap(brand),
      // SSR the queue's primary payload (60s-cached) so the All tab paints
      // with data — the client previously fetched this after hydration and
      // it measured 1.5-2.7s. Fail-open to the client fetch, loudly.
      getProductionReportFast(brand, recentOnly ? "recent-ideas" : "all").catch((err) => {
        Sentry.captureException(err, { tags: { surface: "queue-ssr", brand } });
        return null;
      }),
      listNewsletterFormats(brand),
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
        initialStale={report?.stale === true}
        initialOlderIdeas={report?.olderIdeas ?? null}
        recentOnly={recentOnly}
        brand={brand}
        initialSource="all"
        clippableFormats={clippableFormats.map((f) => ({
          id: f.id,
          name: f.name,
          slug: f.slug,
        }))}
        formatNameToId={formatNameToId}
        showNewsletters={newsletterFormats.length > 0}
        isAdmin={await isAdminNow(session)}
      />
    </Suspense>
  );
}
