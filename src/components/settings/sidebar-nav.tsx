"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/settings/brands", label: "Brands" },
  { href: "/settings/users", label: "Users" },
  { href: "/settings/sync-errors", label: "Sync errors" },
  { href: "/settings/jobs", label: "Jobs" },
] as const;

export function SettingsSidebarNav() {
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
    </nav>
  );
}
