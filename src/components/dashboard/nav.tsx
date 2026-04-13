"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { cn } from "@/lib/utils";
import { BRANDS, DEFAULT_BRAND } from "@/lib/config/brands";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function getBrandFromPath(pathname: string): string {
  const segment = pathname.split("/")[1];
  const match = BRANDS.find((b) => b.slug === segment);
  return match ? match.slug : DEFAULT_BRAND;
}

export function DashboardNav({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const currentBrand = getBrandFromPath(pathname);

  async function handleSignOut() {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
    );
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  function handleBrandChange(slug: string) {
    // Preserve current page when switching brands
    const isOnFormats = pathname.endsWith("/formats");
    router.push(isOnFormats ? `/${slug}/formats` : `/${slug}`);
  }

  const links = [
    { href: `/${currentBrand}`, label: "Dashboard" },
    { href: `/${currentBrand}/formats`, label: "Formats" },
  ];

  return (
    <header className="border-b border-border bg-card">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-12">
          <div className="flex items-center gap-3 sm:gap-6">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-primary flex items-center justify-center">
                <span className="text-primary-foreground text-xs font-bold">H</span>
              </div>
              <span className="text-sm font-semibold text-foreground hidden sm:inline">
                Hub & Spoke
              </span>
            </Link>
            <span className="text-border hidden sm:inline">
              <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" fill="none">
                <path d="M16 3.549L7.12 20.600" />
              </svg>
            </span>
            <Select value={currentBrand} onValueChange={(v) => handleBrandChange(v ?? DEFAULT_BRAND)}>
              <SelectTrigger className="w-[160px] border-none shadow-none font-medium text-foreground px-2 h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BRANDS.map((brand) => (
                  <SelectItem key={brand.slug} value={brand.slug}>
                    <span className="flex items-center gap-2">
                      <span>{brand.emoji}</span>
                      <span>{brand.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <nav className="flex items-center gap-1">
              {links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm transition-colors",
                    pathname === link.href ||
                      (link.label === "Dashboard" && pathname === "/") ||
                      (link.label === "Formats" && pathname === "/formats")
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
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
