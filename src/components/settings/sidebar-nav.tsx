"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface BrandLink {
  slug: string;
  label: string;
}

const SECTIONS = [
  { href: "/settings/users", label: "Users" },
  { href: "/settings/sync-errors", label: "Sync errors" },
  { href: "/settings/jobs", label: "Jobs" },
] as const;

export function SettingsSidebarNav({ brands }: { brands: BrandLink[] }) {
  const pathname = usePathname();

  const itemClass = (active: boolean) =>
    cn(
      "px-2 py-1.5 rounded-md text-sm transition-colors",
      active
        ? "bg-accent text-foreground font-medium"
        : "text-muted-foreground hover:text-foreground hover:bg-accent"
    );

  return (
    <nav className="flex md:flex-col gap-1">
      {SECTIONS.map((s) => (
        <Link
          key={s.href}
          href={s.href}
          className={itemClass(pathname === s.href)}
        >
          {s.label}
        </Link>
      ))}
      <div className="mt-3 px-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        Brand goals
      </div>
      {brands.map((b) => {
        const href = `/settings/brands/${b.slug}`;
        return (
          <Link key={b.slug} href={href} className={itemClass(pathname === href)}>
            {b.label}
          </Link>
        );
      })}
    </nav>
  );
}
