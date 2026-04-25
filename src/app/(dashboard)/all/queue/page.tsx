import { Suspense } from "react";
import type { Metadata } from "next";
import { QueueView } from "@/components/dashboard/queue-view";

export const metadata: Metadata = { title: "Queue · All" };

export default function AllQueuePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <QueueView brand="all" initialSource="all" />
    </Suspense>
  );
}
