import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Toaster } from "sonner";
import { eq } from "drizzle-orm";
import { DashboardNav, SectionTabs } from "@/components/dashboard/nav";
import { getBrands, getDefaultBrandSlug } from "@/lib/db/brands";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }

  // Brands are DB-driven now. Fetch once at the layout level and thread
  // through the nav + section-tabs client components so we avoid re-querying
  // on every navigation. `avatar` maps to `avatar_url` to preserve the
  // existing nav prop shape.
  const rows = await getBrands();
  const defaultBrand = await getDefaultBrandSlug();
  const brands = rows.map((b) => ({
    slug: b.slug,
    label: b.label,
    avatar: b.avatarUrl,
    color: b.color,
    disabled: b.disabled,
  }));

  const [userRow] = session.user.id
    ? await db
        .select({ name: users.name, avatarUrl: users.avatarUrl })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1)
    : [];

  return (
    <div className="min-h-screen bg-background">
      <DashboardNav
        userEmail={session.user.email || ""}
        userName={userRow?.name ?? null}
        userAvatarUrl={userRow?.avatarUrl ?? null}
        brands={brands}
        defaultBrand={defaultBrand}
      />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <div className="mb-4 sm:mb-6">
          <SectionTabs brands={brands} defaultBrand={defaultBrand} />
        </div>
        {children}
      </main>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
