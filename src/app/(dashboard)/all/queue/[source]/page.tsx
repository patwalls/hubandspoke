import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  QueueView,
  type QueueSource,
} from "@/components/dashboard/queue-view";
import { auth } from "@/lib/auth";

interface AllQueueSourcePageProps {
  params: Promise<{ source: string }>;
}

// /all/queue/* spans all brands, so it doesn't show per-brand clip-format
// tabs. The legacy `clip-ideas` slug 404s — operators looking for clip
// triage should pick a brand view, where per-format tabs apply.
const SLUG_TO_SOURCE: Record<string, QueueSource> = {
  triggered: "repurposed",
  repurposed: "spoke",
  "cross-post": "cross_post",
  repost: "repost",
  history: "history",
};

const SOURCE_LABEL: Record<string, string> = {
  all: "All",
  repurposed: "Triggered",
  spoke: "Repurposed",
  cross_post: "Cross-post",
  repost: "Repost",
  history: "History",
};

export async function generateMetadata({
  params,
}: AllQueueSourcePageProps): Promise<Metadata> {
  const { source } = await params;
  const internalSource = SLUG_TO_SOURCE[source];
  if (!internalSource) return { title: "Queue · All" };
  return { title: `Queue · ${SOURCE_LABEL[internalSource]} · All` };
}

export default async function AllQueueSourcePage({
  params,
}: AllQueueSourcePageProps) {
  const { source } = await params;
  const internalSource = SLUG_TO_SOURCE[source];
  if (!internalSource) {
    notFound();
  }
  const session = await auth();

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <QueueView
        brand="all"
        initialSource={internalSource}
        clippableFormats={[]}
        isAdmin={session?.user?.role === "admin"}
      />
    </Suspense>
  );
}
