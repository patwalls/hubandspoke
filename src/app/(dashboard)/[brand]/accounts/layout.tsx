import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { fetchBrandBySlug } from "@/lib/db/brands";
import { AccountsSidebarNav } from "@/components/dashboard/accounts-sidebar-nav";

interface BrandAccountsLayoutProps {
  children: React.ReactNode;
  params: Promise<{ brand: string }>;
}

export default async function BrandAccountsLayout({
  children,
  params,
}: BrandAccountsLayoutProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { brand } = await params;
  const brandConfig = await fetchBrandBySlug(brand);
  if (!brandConfig) notFound();

  return (
    <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6 md:gap-8">
      <aside className="md:sticky md:top-4 self-start">
        <div className="mb-4">
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
            Accounts
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {brandConfig.label}
          </p>
        </div>
        <AccountsSidebarNav brand={brand} />
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
