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
    <nav className="flex md:flex-col gap-1">
      {items.map((s) => {
        const active = pathname === s.href;
        return (
          <Link
            key={s.href}
            href={s.href}
            className={cn(
              "px-2 py-1.5 rounded-md text-sm transition-colors",
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
