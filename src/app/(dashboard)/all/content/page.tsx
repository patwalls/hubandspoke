import { Suspense } from "react";
import type { Metadata } from "next";
import { ContentView } from "@/components/dashboard/content-view";

export const metadata: Metadata = { title: "Content · All" };

export default function AllContentPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <ContentView brand="all" />
    </Suspense>
  );
}
