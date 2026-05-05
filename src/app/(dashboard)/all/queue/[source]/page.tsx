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

const SLUG_TO_SOURCE: Record<string, QueueSource> = {
  original: "original",
  repost: "repost",
  "cross-post": "cross_post",
  clip: "clip",
  history: "history",
};

const SOURCE_LABEL: Record<QueueSource, string> = {
  all: "All",
  original: "Original",
  repost: "Repost",
  cross_post: "Cross-post",
  clip: "Clip",
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
        isAdmin={session?.user?.role === "admin"}
      />
    </Suspense>
  );
}
