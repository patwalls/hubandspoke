import { Suspense } from "react";
import type { Metadata } from "next";
import { ProductionView } from "@/components/dashboard/production-view";

export const metadata: Metadata = { title: "Production · All" };

export default function AllProductionPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <ProductionView brand="all" />
    </Suspense>
  );
}
