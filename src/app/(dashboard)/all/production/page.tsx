import { Suspense } from "react";
import type { Metadata } from "next";
import { ProductionView } from "@/components/dashboard/production-view";
import { auth } from "@/lib/auth";

export const metadata: Metadata = { title: "Production · All" };

export default async function AllProductionPage() {
  const session = await auth();
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <ProductionView
        brand="all"
        currentUserId={session?.user?.id ?? null}
      />
    </Suspense>
  );
}
