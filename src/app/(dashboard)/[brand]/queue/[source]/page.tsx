import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import {
  QueueView,
  type QueueSource,
} from "@/components/dashboard/queue-view";
import { getClippableFormats, getFormatNameToIdMap } from "@/lib/db/formats";
import { auth } from "@/lib/auth";

interface BrandQueueSourcePageProps {
  params: Promise<{ brand: string; source: string }>;
}

const STATIC_SLUG_TO_SOURCE: Record<string, QueueSource> = {
  triggered: "repurposed",
  repurposed: "spoke",
  "cross-post": "cross_post",
  repost: "repost",
  history: "history",
};

const STATIC_SOURCE_LABEL: Record<string, string> = {
  all: "All",
  repurposed: "Triggered",
  spoke: "Repurposed",
  cross_post: "Cross-post",
  repost: "Repost",
  history: "History",
};

export async function generateMetadata({
  params,
}: BrandQueueSourcePageProps): Promise<Metadata> {
  const { brand, source } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) return { title: "Queue" };
  if (STATIC_SLUG_TO_SOURCE[source]) {
    return {
      title: `Queue · ${STATIC_SOURCE_LABEL[STATIC_SLUG_TO_SOURCE[source]]} · ${brandConfig.label}`,
    };
  }
  // Dynamic per-clippable-format tab — look up the format by slug and use
  // its display name in the title.
  const clippable = await getClippableFormats(brand);
  const matched = clippable.find((f) => f.slug === source);
  if (matched) {
    return { title: `Queue · ${matched.name} · ${brandConfig.label}` };
  }
  return { title: "Queue" };
}

export default async function BrandQueueSourcePage({
  params,
}: BrandQueueSourcePageProps) {
  const { brand, source } = await params;
  const [brandConfig, session, clippableFormats, formatNameToId] =
    await Promise.all([
      fetchBrandBySlug(brand),
      auth(),
      getClippableFormats(brand),
      getFormatNameToIdMap(brand),
    ]);
  if (!brandConfig) notFound();

  // Resolve the URL slug to (a) one of the fixed queue sources, or (b) a
  // clip-format-specific source like `clip:<format-id>`. The dynamic
  // discriminator lets the QueueView component apply the per-format
  // filter without baking format names into a static union type.
  let initialSource: QueueSource;
  let clipFormatFilter: string | null = null;
  if (STATIC_SLUG_TO_SOURCE[source]) {
    initialSource = STATIC_SLUG_TO_SOURCE[source];
  } else if (source === "clip-ideas") {
    // Legacy URL from before the per-format split (2026-05-21). Redirect
    // bookmarks to the brand's first clippable format so they don't 404.
    if (clippableFormats.length > 0) {
      redirect(`/${brand}/queue/${clippableFormats[0].slug}`);
    }
    notFound();
  } else {
    const matched = clippableFormats.find((f) => f.slug === source);
    if (!matched) notFound();
    initialSource = `clip:${matched.id}` as QueueSource;
    clipFormatFilter = matched.name;
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
        brand={brand}
        initialSource={initialSource}
        initialClipFormatFilter={clipFormatFilter}
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
