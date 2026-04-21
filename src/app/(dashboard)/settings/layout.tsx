import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { BRANDS } from "@/lib/config/brands";
import { SettingsSidebarNav } from "@/components/settings/sidebar-nav";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  const brandLinks = BRANDS.filter((b) => !b.disabled).map((b) => ({
    slug: b.slug,
    label: b.label,
  }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 md:gap-8">
      <aside className="md:sticky md:top-4 self-start">
        <div className="mb-4">
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
            Settings
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manage your workspace
          </p>
        </div>
        <SettingsSidebarNav brands={brandLinks} />
      </aside>
      <main>{children}</main>
    </div>
  );
}
