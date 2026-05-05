import { Suspense } from "react";
import type { Metadata } from "next";
import { QueueView } from "@/components/dashboard/queue-view";
import { auth } from "@/lib/auth";

export const metadata: Metadata = { title: "Queue · All" };

export default async function AllQueuePage() {
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
        initialSource="all"
        isAdmin={session?.user?.role === "admin"}
      />
    </Suspense>
  );
}
