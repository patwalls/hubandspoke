"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, CheckIcon, ChevronLeft, ChevronRight, XIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { BackLink } from "@/components/dashboard/back-link";
import { cn } from "@/lib/utils";
import { trackUsage } from "@/lib/usage/track";
import {
  isTypingTarget,
  leaveRun,
  positionInRun,
  readRun,
  saveRun,
  type ProductionRun,
  type RunPosition,
  type RunRow,
} from "@/lib/production/run";

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
    const run = readRun(brand);
    const p = positionInRun(run, contentId);
    setPos(p);
    if (p && run) {
      trackUsage("content:production-run", brand);
      // Back on the list, the cursor starts on this post's row (M2).
      saveRun({ ...run, current: contentId });
    }
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

/**
 * After a status change on a post opened from In Production (production-run
 * M3): "Moved to Ready To Publish. Next in Review (4 left): <title>" with
 * Open next (or j). The post is dropped from the remembered run so the next
 * page counts the smaller group. Reviewers approved a post and went straight
 * back to the list for the next one; this is that next one.
 *
 * Stays out of the way of My Work's next card (`UpNext`), which speaks for
 * the same moment when the post just left your plate: `suppressed` hides
 * this one while that one shows.
 */
export function RunNextCard({
  brand,
  itemId,
  status,
  suppressed,
}: {
  brand: string;
  itemId: string;
  status: string;
  suppressed: boolean;
}) {
  const router = useRouter();
  // The status the post had when the page opened, and the run before it left.
  const start = useRef<{ itemId: string; status: string } | null>(null);
  const before = useRef<ProductionRun | null>(null);
  const [card, setCard] = useState<{ itemId: string; group: string; to: string; next: RunRow | null; left: number } | null>(
    null,
  );
  // The card, once it has waited its beat (see below).
  const [readyCard, setReadyCard] = useState<typeof card>(null);

  useEffect(() => {
    if (!status) return;
    if (start.current?.itemId !== itemId) {
      start.current = { itemId, status };
      before.current = null;
      setCard(null);
      return;
    }
    const from = start.current.status;
    const run = before.current ?? readRun(brand);
    if (!run || run.group !== from) return;
    if (status === from) {
      // Moved back (undo): put the row back where it was.
      if (before.current) saveRun(before.current);
      before.current = null;
      setCard(null);
      return;
    }
    const left = leaveRun(run, itemId);
    if (!left) return;
    before.current = run;
    saveRun({ ...left.run, current: left.next?.id ?? itemId });
    setCard({ itemId, group: run.group, to: status, next: left.next, left: left.run.rows.length });
    trackUsage("content:production-run:next-card", brand);
  }, [brand, itemId, status]);

  // My Work's card decides a beat after the status change (one fetch); wait
  // that beat so the two don't flash in turn.
  useEffect(() => {
    if (!card) return;
    const t = setTimeout(() => setReadyCard(card), 700);
    return () => clearTimeout(t);
  }, [card]);

  const shown = card && card.itemId === itemId && readyCard === card && !suppressed ? card : null;

  useEffect(() => {
    if (!shown?.next) return;
    const next = shown.next;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
      if (isTypingTarget(document.activeElement as HTMLElement | null)) return;
      if (document.querySelector('[role="dialog"]')) return;
      // Ahead of ContentBackNav's j, which only knows the old run.
      e.preventDefault();
      e.stopPropagation();
      trackUsage("content:production-run:next-card:open", brand);
      router.push(`/${brand}/content/${next.id}`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, brand, router]);

  if (!shown) return null;
  return (
    <div
      role="status"
      data-testid="production-run-next-card"
      className="fixed bottom-24 right-6 z-50 w-80 rounded-lg border bg-background p-3 shadow-lg"
    >
      <div className="flex items-start gap-2">
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1 text-sm">
          {shown.next ? (
            <>
              <p className="text-muted-foreground">
                Moved to {shown.to}. Next in {shown.group}
                {shown.left > 1 ? ` (${shown.left} left)` : ""}:
              </p>
              <p className="mt-0.5 truncate font-medium">{shown.next.title}</p>
            </>
          ) : (
            <p className="font-medium">
              Moved to {shown.to}. That was the last one in {shown.group}.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCard(null)}
          aria-label="Close"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-end gap-2">
        <BackLink brand={brand} listKey="production" fallbackHref={`/${brand}/production`} className={BACK_CLASS}>
          ← In Production
        </BackLink>
        {shown.next && (
          <Link
            href={`/${brand}/content/${shown.next.id}`}
            onClick={() => trackUsage("content:production-run:next-card:open", brand)}
            title="Open next (j)"
            className={buttonVariants({ size: "sm" })}
          >
            Open next <ArrowRightIcon className="size-3.5" />
          </Link>
        )}
      </div>
    </div>
  );
}
