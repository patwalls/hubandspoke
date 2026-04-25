import { Suspense } from "react";
import type { Metadata } from "next";
import { ContentReport } from "@/components/dashboard/content-report";

export const metadata: Metadata = { title: "Dashboard · All" };

// Cross-brand home — same component the per-brand `/[brand]` home renders,
// passed `brand="all"` so the queries.ts side drops the brand predicate and
// aggregates every brand into one view. The MATG dashboard branch from the
// per-brand home is intentionally not mirrored here; "all" is never matg.
export default function AllHomePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <ContentReport brand="all" />
    </Suspense>
  );
}
