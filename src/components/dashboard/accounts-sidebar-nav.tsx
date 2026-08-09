"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface Props {
  brand: string;
}

export function AccountsSidebarNav({ brand }: Props) {
  const pathname = usePathname();
  const base = `/${brand}/accounts`;

  const items = [
    { href: base, label: "Accounts" },
    { href: `${base}/goals`, label: "Goals" },
    { href: `${base}/boundaries`, label: "Boundaries" },
    { href: `${base}/cross-posting`, label: "Cross posting" },
    { href: `${base}/statuses`, label: "Statuses" },
    { href: `${base}/brand-assets`, label: "Brand assets" },
  ];

  return (
    // On phones this renders as a horizontal pill row — it must scroll within
    // itself (overflow-x-auto) instead of widening the page.
    <nav className="flex md:flex-col gap-1 overflow-x-auto no-scrollbar">
      {items.map((s) => {
        const active = pathname === s.href;
        return (
          <Link
            key={s.href}
            href={s.href}
            className={cn(
              "px-2 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap shrink-0",
              active
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
