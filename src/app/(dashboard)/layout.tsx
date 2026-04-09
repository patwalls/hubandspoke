import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { DashboardNav } from "@/components/dashboard/nav";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-background">
      <DashboardNav userEmail={user.email || ""} />
      <main className="max-w-[1600px] mx-auto px-6 py-8">
        {children}
      </main>
    </div>
  );
}
