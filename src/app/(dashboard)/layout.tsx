import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Toaster } from "sonner";
import { DashboardNav, SectionTabs } from "@/components/dashboard/nav";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-background">
      <DashboardNav userEmail={session.user.email || ""} />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <div className="mb-4 sm:mb-6">
          <SectionTabs />
        </div>
        {children}
      </main>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
