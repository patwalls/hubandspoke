import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Toaster } from "sonner";
import { eq } from "drizzle-orm";
import { DashboardNav, SectionTabs } from "@/components/dashboard/nav";
import { ScCreditsBanner } from "@/components/dashboard/sc-credits-banner";
import { DescriptCreditsBanner } from "@/components/dashboard/descript-credits-banner";
import { ScheduledAttentionBanner } from "@/components/dashboard/scheduled-attention-banner";
import { SentryUser } from "@/components/sentry-user";
import { UsageTracker } from "@/components/dashboard/usage-tracker";
import { WhatsNewDialog, type WhatsNewCard } from "@/components/dashboard/whats-new-dialog";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getBrands, getDefaultBrandSlug } from "@/lib/db/brands";
import { editableBrandSlugs } from "@/lib/brand-access";
import { BrandAccessProvider } from "@/components/brand-access";
import { setSentrySessionUser } from "@/lib/sentry-user";
import { hrefFor, unseenFor, visibleTo, type WhatsNewEntry } from "@/lib/whats-new";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  setSentrySessionUser(session);

  const [userRow] = session.user.id
    ? await db
        .select({
          name: users.name,
          avatarUrl: users.avatarUrl,
          role: users.role,
          whatsNewSeenAt: users.whatsNewSeenAt,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1)
    : [];

  // Brands are DB-driven — fetch once per request at the layout and thread
  // through the nav + section-tabs. `avatar` maps the DB's `avatar_url`
  // column to the nav's existing prop shape.
  // Which brands this user can change — drives disabled edit controls across
  // the UI (src/components/brand-access.tsx). The API enforces it regardless.
  const editableSlugs = await editableBrandSlugs(session);
  const editable = editableSlugs === "all" ? ("all" as const) : [...editableSlugs];

  const brandRows = await getBrands();
  const defaultBrand = await getDefaultBrandSlug();
  // Synthetic "All content" entry rendered to the left of every real brand.
  // Not in the DB on purpose — making it a real `brands` row would pollute
  // every brand-keyed query (accounts FK joins, format lookups, the
  // brand-priority sort, the cross-post recommender). The /all routes
  // recognize the slug as a sentinel; queries.ts drops the brand predicate
  // when `brand === "all"`.
  const allEntry = {
    slug: "all",
    label: "All",
    avatar: null,
    color: "from-slate-700 to-slate-900",
    disabled: false,
    parent: null,
  };
  // What's new: the cards this user hasn't seen pop up once; the nav menu
  // reopens the full list. Links get the default brand filled in.
  // DB role, not the sign-in JWT, so a promotion shows up without re-login.
  const viewer = { email: session.user.email, role: userRow?.role ?? session.user.role };
  const toCard = (e: WhatsNewEntry): WhatsNewCard => ({
    id: e.id,
    shippedAt: e.shippedAt,
    kind: e.kind,
    title: e.title,
    body: e.body,
    href: hrefFor(e, defaultBrand),
  });
  const whatsNewUnseen = userRow
    ? unseenFor(viewer, userRow.whatsNewSeenAt, userRow.createdAt).map(toCard)
    : [];
  const whatsNewAll = visibleTo(viewer).slice(0, 30).map(toCard);

  const brands = [
    allEntry,
    ...brandRows.map((b) => ({
      slug: b.slug,
      label: b.label,
      avatar: b.avatarUrl,
      color: b.color,
      disabled: b.disabled,
      parent: b.parentBrandId
        ? (brandRows.find((p) => p.id === b.parentBrandId)?.slug ?? null)
        : null,
    })),
  ];

  return (
    <BrandAccessProvider editable={editable}>
    <div className="min-h-screen bg-background">
      <SentryUser
        id={session.user.id as string}
        email={session.user.email || ""}
        name={userRow?.name ?? null}
      />
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
        <ScCreditsBanner />
        <DescriptCreditsBanner />
        <ScheduledAttentionBanner />
        {children}
      </main>
      <Suspense fallback={null}>
        <UsageTracker />
      </Suspense>
      <WhatsNewDialog unseen={whatsNewUnseen} all={whatsNewAll} />
      <Toaster position="bottom-right" richColors closeButton />
    </div>
    </BrandAccessProvider>
  );
}
