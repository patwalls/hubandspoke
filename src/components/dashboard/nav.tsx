"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { LayoutGrid, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { GlobalSearch } from "@/components/dashboard/global-search";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BackLink } from "@/components/dashboard/back-link";
import { BrandAvatar as BrandAvatarChip } from "@/components/ui/brand-avatar";

// Brand shape passed down from the (server) layout — mirrors BrandListEntry
// from @/lib/db/brands but redeclared locally so this client component
// doesn't pull in a server-only module. `avatar` maps to the DB's
// `avatar_url` to keep the existing JSX unchanged.
type Brand = {
  slug: string;
  label: string;
  avatar: string | null;
  color: string | null;
  disabled: boolean;
};

function getBrandFromPath(
  pathname: string,
  brands: Brand[],
  fallback: string
): string {
  const segment = pathname.split("/")[1];
  const match = brands.find((b) => b.slug === segment);
  return match ? match.slug : fallback;
}

function BrandAvatar({ brand, size = 20 }: { brand: Brand; size?: number }) {
  // The synthetic "all" sidebar entry shouldn't show initials — "A" reads
  // like a real brand acronym. A grid icon reads as "every brand at once"
  // at a glance and stays visually distinct from real brand avatars.
  if (brand.slug === "all") {
    // Icon at ~58% of the avatar size so the four squares stay distinct
    // without crowding the circle's edge. A heavier strokeWidth gives the
    // glyph the same visual weight as the photo avatars used for real
    // brands — without it, the All chip reads smaller than its neighbors.
    const iconSize = Math.round(size * 0.58);
    return (
      <span
        className={cn(
          "rounded-full bg-gradient-to-br text-white flex items-center justify-center select-none shrink-0",
          brand.color
        )}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <LayoutGrid size={iconSize} strokeWidth={2.5} />
      </span>
    );
  }

  return (
    <BrandAvatarChip
      label={brand.label}
      avatarUrl={brand.avatar}
      color={brand.color}
      size={size}
    />
  );
}

function UserAvatar({
  name,
  email,
  avatarUrl,
  size = 24,
}: {
  name: string | null;
  email: string;
  avatarUrl: string | null;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);
  const source = name || email;
  const initials = source
    .split(/[\s@.]+/)
    .filter((w) => /[A-Za-z0-9]/.test(w[0] ?? ""))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  if (!errored && avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        onError={() => setErrored(true)}
        className="rounded-full object-cover bg-muted"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      className="rounded-full bg-gradient-to-br from-[#ff7a59] to-[#ff5c35] text-white font-semibold flex items-center justify-center select-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initials || "?"}
    </span>
  );
}

type NavProps = {
  userEmail: string;
  userName?: string | null;
  userAvatarUrl?: string | null;
  brands: Brand[];
  defaultBrand: string;
};

export function DashboardNav({
  userEmail,
  userName = null,
  userAvatarUrl = null,
  brands,
  defaultBrand,
}: NavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const currentBrand = getBrandFromPath(pathname, brands, defaultBrand);
  const isOnFormats = pathname.endsWith("/formats");
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isK = e.key === "k" || e.key === "K";
      if (isK && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleSignOut() {
    await signOut({ callbackUrl: "/login" });
  }

  return (
    <header className="border-b border-border bg-card">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-12">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <Link href="/" className="flex items-center gap-2 shrink-0 group">
              <span className="w-6 h-6 rounded-md bg-gradient-to-br from-[#ff7a59] to-[#ff5c35] flex items-center justify-center shadow-sm ring-1 ring-[#ff5c35]/20">
                <span className="text-white text-[11px] font-bold leading-none tracking-tight">H</span>
              </span>
              <span className="text-sm font-semibold text-foreground hidden sm:inline tracking-tight">
                Hub &amp; Spoke
              </span>
            </Link>
            <span className="hidden sm:inline-block h-4 w-px bg-border shrink-0" />
            <a
              href="https://www.hubspot.com/podcast-network"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline-flex items-center shrink-0 opacity-60 hover:opacity-100 transition-opacity"
              title="by HubSpot Media"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/hubspot-media.png"
                alt="by HubSpot Media"
                className="h-3.5 w-auto"
                style={{ filter: "brightness(0)" }}
              />
            </a>
            <span className="text-border hidden sm:inline shrink-0">
              <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" fill="none">
                <path d="M16 3.549L7.12 20.600" />
              </svg>
            </span>
            <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
              {brands.map((brand) => {
                const isActive = currentBrand === brand.slug;
                // "all" only has a home — Formats/Accounts/etc. don't exist
                // there, so collapse any cross-section navigation back to /all.
                const href =
                  brand.slug === "all"
                    ? "/all"
                    : isOnFormats
                      ? `/${brand.slug}/formats`
                      : `/${brand.slug}`;

                if (brand.disabled) {
                  return (
                    <span
                      key={brand.slug}
                      title="Coming soon"
                      aria-disabled="true"
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm text-muted-foreground/60 cursor-not-allowed select-none shrink-0"
                    >
                      <span className="inline-flex items-center leading-none grayscale opacity-60">
                        <BrandAvatar brand={brand} />
                      </span>
                      <span className="hidden md:inline">{brand.label}</span>
                    </span>
                  );
                }

                return (
                  <Link
                    key={brand.slug}
                    href={href}
                    title={brand.label}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-1.5 px-2 py-1 rounded-md text-sm transition-all shrink-0",
                      isActive
                        ? "bg-accent text-foreground font-medium ring-1 ring-border"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                    )}
                  >
                    <span
                      className={cn(
                        // inline-flex + leading-none so the wrapper sizes to
                        // the 20px avatar instead of generating a 25px line
                        // box (the inline-block <img> child otherwise inflates
                        // the parent button from 28→33px and breaks vertical
                        // alignment with the icon-only "All" pill).
                        "inline-flex items-center leading-none transition-transform group-hover:scale-110",
                        isActive ? "" : "opacity-90 group-hover:opacity-100"
                      )}
                    >
                      <BrandAvatar brand={brand} />
                    </span>
                    <span className="hidden md:inline">{brand.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Open search (⌘K)"
              className="group flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:bg-accent"
            >
              <SearchIcon className="size-3.5" />
              <span className="hidden sm:inline">Search…</span>
              <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border bg-muted/60 px-1 py-px text-[10px] font-medium text-muted-foreground group-hover:text-foreground">
                <span className="text-[11px] leading-none">⌘</span>K
              </kbd>
            </button>
            <NotificationBell />
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account menu"
                className="flex items-center gap-1.5 rounded-full p-0.5 pr-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <UserAvatar
                  name={userName}
                  email={userEmail}
                  avatarUrl={userAvatarUrl}
                />
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                  className="opacity-70"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <div className="flex items-center gap-2.5 px-2 py-2">
                  <UserAvatar
                    name={userName}
                    email={userEmail}
                    avatarUrl={userAvatarUrl}
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    {userName ? (
                      <div className="text-sm font-medium text-foreground truncate">
                        {userName}
                      </div>
                    ) : null}
                    <div className="text-xs text-muted-foreground truncate">
                      {userEmail}
                    </div>
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => router.push("/settings")}
                  className="cursor-pointer"
                >
                  Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleSignOut}
                  className="cursor-pointer"
                >
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
      <GlobalSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        brand={currentBrand}
      />
    </header>
  );
}

export function SectionTabs({
  brands,
  defaultBrand,
}: {
  brands: Brand[];
  defaultBrand: string;
}) {
  const pathname = usePathname();
  const currentBrand = getBrandFromPath(pathname, brands, defaultBrand);

  // The /all view aggregates data across brands; Formats and Accounts are
  // brand-scoped configuration (format library, account goals/boundaries)
  // and have no coherent cross-brand version, so they're hidden there.
  const tabs =
    currentBrand === "all"
      ? [
          { href: `/all`, label: "Dashboard" },
          { href: `/all/content`, label: "Content" },
          { href: `/all/production`, label: "Production" },
          { href: `/all/queue`, label: "Queue" },
        ]
      : [
          { href: `/${currentBrand}`, label: "Dashboard" },
          { href: `/${currentBrand}/content`, label: "Content" },
          { href: `/${currentBrand}/production`, label: "Production" },
          { href: `/${currentBrand}/queue`, label: "Queue" },
          { href: `/${currentBrand}/scheduled`, label: "Scheduled" },
          { href: `/${currentBrand}/formats`, label: "Formats" },
          { href: `/${currentBrand}/accounts`, label: "Accounts" },
        ];

  // Surface a context-aware back link to the LEFT of the tabs when we're
  // on a detail page (`/<brand>/content/<id>` or `/<brand>/formats/<id>`).
  // Each detail page used to render its own breadcrumb row that ate ~50px
  // of vertical space for a single link in an otherwise-empty row; we
  // fold the back affordance into the already-drawn section-tabs row.
  //
  // Restores the exact filtered list URL via `<BackLink>` (reads
  // sessionStorage written by `useRememberListUrl` on the corresponding
  // list page). Deep-link / new-tab / cleared-session fall through to
  // the hardcoded list path.
  const contentDetailMatch = pathname.match(
    /^\/([^/]+)\/content\/[^/]+(?:\/|$)/,
  );
  const formatDetailMatch = !contentDetailMatch
    ? pathname.match(/^\/([^/]+)\/formats\/[^/]+(?:\/|$)/)
    : null;
  const backLink = contentDetailMatch
    ? {
        brand: contentDetailMatch[1],
        listKey: "content",
        fallbackHref: `/${contentDetailMatch[1]}/content`,
        label: "← Content",
      }
    : formatDetailMatch
      ? {
          brand: formatDetailMatch[1],
          listKey: "formats",
          fallbackHref: `/${formatDetailMatch[1]}/formats`,
          label: "← Formats",
        }
      : null;

  return (
    <div className="flex items-center gap-3">
      {backLink && (
        <BackLink
          brand={backLink.brand}
          listKey={backLink.listKey}
          fallbackHref={backLink.fallbackHref}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {backLink.label}
        </BackLink>
      )}
      <div className="inline-flex items-center gap-1 rounded-lg bg-muted/60 p-1">
        {tabs.map((tab) => {
          const isActive =
            pathname === tab.href ||
            (tab.label === "Dashboard" && pathname === "/") ||
            (tab.label === "Content" && pathname === "/content") ||
            (tab.label === "Queue" &&
              (pathname === "/queue" || pathname.startsWith(`${tab.href}/`))) ||
            (tab.label === "Scheduled" && pathname === "/scheduled") ||
            (tab.label === "Production" && pathname === "/production") ||
            (tab.label === "Formats" && pathname === "/formats") ||
            (tab.label === "Accounts" && pathname.endsWith("/accounts"));
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "px-3 py-1.5 rounded-md text-sm transition-colors",
                isActive
                  ? "bg-card text-foreground font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
