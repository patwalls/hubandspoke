import { notFound } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { getAccounts } from "@/lib/db/accounts";
import { getBrandStatuses } from "@/lib/db/brand-statuses";
import { ContentDetail } from "@/components/dashboard/content-detail";
import { getProductionItemDetail } from "@/lib/services/production-item-detail";
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
  const [accountRows, statusRows, session, detailPayload] = await Promise.all([
    getAccounts(),
    getBrandStatuses(brand),
    auth(),
    // SSR the detail payload so the first paint carries data — no client
    // shell->hydrate->fetch waterfall. Fail-open for the USER (the client
    // falls back to its own fetch) but NEVER silent: the error goes to
    // Sentry so the ops loop sees it. A swallowed catch here is how a
    // broken SSR path would hide for days.
    getProductionItemDetail(contentId).catch((err) => {
      Sentry.captureException(err, {
        tags: { surface: "detail-ssr", contentId },
      });
      return null;
    }),
  ]);
  // JSON-roundtrip so the client receives EXACTLY the fetch-path shape
  // (Dates as ISO strings, undefined dropped) — one code path, no drift.
  const initialData = detailPayload
    ? (JSON.parse(JSON.stringify(detailPayload)) as Parameters<
        typeof ContentDetail
      >[0]["initialData"])
    : null;
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
      // key: App Router reuses the client component across detail->detail
      // navigations; keying by id forces a remount so useState(initialData)
      // and the run-once hydrate effect are always for THIS item.
      key={contentId}
      initialData={initialData}
      brand={brand}
      contentId={contentId}
      accounts={accounts}
      shortLinksBaseUrl={shortLinksBaseUrl}
      statuses={statuses}
      isAdmin={isAdmin}
    />
  );
}
