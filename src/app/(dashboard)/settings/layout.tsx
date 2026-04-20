import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { BRANDS } from "@/lib/config/brands";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

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
        <nav className="flex md:flex-col gap-1">
          <Link
            href="/settings/users"
            className="px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent transition-colors"
          >
            Users
          </Link>
          <div className="mt-3 px-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            Brand goals
          </div>
          {BRANDS.filter((b) => !b.disabled).map((b) => (
            <Link
              key={b.slug}
              href={`/${b.slug}/settings`}
              className="px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              {b.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main>{children}</main>
    </div>
  );
}
