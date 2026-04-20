"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { BRANDS, DEFAULT_BRAND } from "@/lib/config/brands";
import { NotificationBell } from "@/components/notifications/notification-bell";

type Brand = (typeof BRANDS)[number];

function getBrandFromPath(pathname: string): string {
  const segment = pathname.split("/")[1];
  const match = BRANDS.find((b) => b.slug === segment);
  return match ? match.slug : DEFAULT_BRAND;
}

function BrandAvatar({ brand, size = 22 }: { brand: Brand; size?: number }) {
  const [errored, setErrored] = useState(false);
  const initials = brand.label
    .split(" ")
    .filter((w) => /[A-Za-z0-9]/.test(w[0] ?? ""))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  if (!errored && brand.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={brand.avatar}
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
      className={cn(
        "rounded-full bg-gradient-to-br text-white font-semibold flex items-center justify-center select-none",
        brand.color
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initials}
    </span>
  );
}

export function DashboardNav({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  const currentBrand = getBrandFromPath(pathname);
  const isOnFormats = pathname.endsWith("/formats");

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
              {BRANDS.map((brand) => {
                const isActive = currentBrand === brand.slug;
                const href = isOnFormats ? `/${brand.slug}/formats` : `/${brand.slug}`;

                if (brand.disabled) {
                  return (
                    <span
                      key={brand.slug}
                      title="Coming soon"
                      aria-disabled="true"
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm text-muted-foreground/60 cursor-not-allowed select-none shrink-0"
                    >
                      <span className="grayscale opacity-60">
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
                        "transition-transform group-hover:scale-110",
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
            <Link
              href="/my-work"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors hidden sm:inline"
            >
              My Work
            </Link>
            <NotificationBell />
            <span className="text-xs text-muted-foreground hidden sm:inline truncate max-w-[150px]">{userEmail}</span>
            <button
              onClick={handleSignOut}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

export function SectionTabs() {
  const pathname = usePathname();
  const currentBrand = getBrandFromPath(pathname);

  const tabs = [
    { href: `/${currentBrand}`, label: "Dashboard" },
    { href: `/${currentBrand}/content`, label: "Content" },
    { href: `/${currentBrand}/production`, label: "Production" },
    { href: `/${currentBrand}/formats`, label: "Formats" },
    { href: `/settings`, label: "Settings" },
  ];

  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-muted/60 p-1">
      {tabs.map((tab) => {
        const isActive =
          pathname === tab.href ||
          (tab.label === "Dashboard" && pathname === "/") ||
          (tab.label === "Content" && pathname === "/content") ||
          (tab.label === "Production" && pathname === "/production") ||
          (tab.label === "Formats" && pathname === "/formats") ||
          (tab.label === "Settings" && pathname.startsWith("/settings")) ||
          (tab.label === "Settings" && pathname.endsWith("/settings"));
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
  );
}
