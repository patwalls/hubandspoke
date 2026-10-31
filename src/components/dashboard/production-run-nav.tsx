"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { BackLink } from "@/components/dashboard/back-link";
import { cn } from "@/lib/utils";
import { trackUsage } from "@/lib/usage/track";
import { isTypingTarget, positionInRun, readRun, type RunPosition } from "@/lib/production/run";

const BACK_CLASS =
  "inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground";

/**
 * The content page's back link, in the tab row. Opened from the In
 * Production list, it goes back to that list (filters kept) and steps
 * through the row's status group: "Review · 3 of 12 ‹ ›", or j / k. People
 * opened a post, went back to the list and opened the next one about ten
 * times a day each; this skips the list. Opened from anywhere else it is the
 * plain "← Content" link it always was.
 */
export function ContentBackNav({ brand, contentId }: { brand: string; contentId: string }) {
  const router = useRouter();
  const [pos, setPos] = useState<RunPosition | null>(null);

  useEffect(() => {
    const p = positionInRun(readRun(brand), contentId);
    setPos(p);
    if (p) trackUsage("content:production-run", brand);
  }, [brand, contentId]);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
      if (isTypingTarget(document.activeElement as HTMLElement | null)) return;
      // An open dialog (clip editor, publish) owns the keyboard.
      if (document.querySelector('[role="dialog"]')) return;
      const target = e.key === "j" ? pos.next : e.key === "k" ? pos.prev : null;
      if (!target) return;
      e.preventDefault();
      trackUsage("content:production-run:step", brand);
      router.push(`/${brand}/content/${target.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos, brand, router]);

  if (!pos) {
    return (
      <BackLink brand={brand} listKey="content" fallbackHref={`/${brand}/content`} className={BACK_CLASS}>
        ← Content
      </BackLink>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2" data-testid="production-run">
      <BackLink brand={brand} listKey="production" fallbackHref={`/${brand}/production`} className={BACK_CLASS}>
        ← In Production
      </BackLink>
      <div className="inline-flex items-center gap-0.5 rounded-md border border-border/60 pl-2 text-xs text-muted-foreground">
        <span className="tabular-nums" data-testid="production-run-position">
          {pos.group} · {pos.index} of {pos.total}
        </span>
        <StepLink brand={brand} row={pos.prev} label="Previous" hint="k">
          <ChevronLeft className="size-3.5" />
        </StepLink>
        <StepLink brand={brand} row={pos.next} label="Next" hint="j">
          <ChevronRight className="size-3.5" />
        </StepLink>
      </div>
    </div>
  );
}

function StepLink({
  brand,
  row,
  label,
  hint,
  children,
}: {
  brand: string;
  row: RunPosition["next"];
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  const cls = "inline-flex size-6 items-center justify-center rounded";
  if (!row) {
    return (
      <span aria-disabled="true" aria-label={label} className={cn(cls, "opacity-30")}>
        {children}
      </span>
    );
  }
  return (
    <Link
      href={`/${brand}/content/${row.id}`}
      aria-label={label}
      title={`${label}: ${row.title} (${hint})`}
      onClick={() => trackUsage("content:production-run:step", brand)}
      className={cn(cls, "transition-colors hover:bg-accent hover:text-foreground")}
    >
      {children}
    </Link>
  );
}
