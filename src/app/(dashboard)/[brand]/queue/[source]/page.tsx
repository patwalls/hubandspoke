import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { fetchBrandBySlug } from "@/lib/db/brands";
import {
  QueueView,
  type QueueSource,
} from "@/components/dashboard/queue-view";
import { auth } from "@/lib/auth";

interface BrandQueueSourcePageProps {
  params: Promise<{ brand: string; source: string }>;
}

const SLUG_TO_SOURCE: Record<string, QueueSource> = {
  triggered: "repurposed",
  "clip-ideas": "clip_ideas",
  "cross-post": "cross_post",
  repost: "repost",
  history: "history",
};

const SOURCE_LABEL: Record<QueueSource, string> = {
  all: "All",
  repurposed: "Triggered",
  clip_ideas: "Clip Ideas",
  cross_post: "Cross-post",
  repost: "Repost",
  history: "History",
};

export async function generateMetadata({
  params,
}: BrandQueueSourcePageProps): Promise<Metadata> {
  const { brand, source } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  const internalSource = SLUG_TO_SOURCE[source];
  if (!brandConfig || !internalSource) return { title: "Queue" };
  return {
    title: `Queue · ${SOURCE_LABEL[internalSource]} · ${brandConfig.label}`,
  };
}

export default async function BrandQueueSourcePage({
  params,
}: BrandQueueSourcePageProps) {
  const { brand, source } = await params;
  const [brandConfig, session] = await Promise.all([
    fetchBrandBySlug(brand),
    auth(),
  ]);
  const internalSource = SLUG_TO_SOURCE[source];

  if (!brandConfig || !internalSource) {
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
        brand={brand}
        initialSource={internalSource}
        isAdmin={session?.user?.role === "admin"}
      />
    </Suspense>
  );
}
