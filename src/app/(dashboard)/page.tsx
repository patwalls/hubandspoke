import { Suspense } from "react";
import { ContentReport } from "@/components/dashboard/content-report";

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <div className="text-gray-400">Loading...</div>
        </div>
      }
    >
      <ContentReport />
    </Suspense>
  );
}
