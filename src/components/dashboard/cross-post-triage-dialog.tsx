"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccountAvatar } from "@/components/ui/account-avatar";
import { AccountBadge } from "@/components/ui/account-badge";
import {
  PLATFORM_META,
  POST_TYPE_SHORT_LABEL,
  toPlatform,
} from "@/lib/platforms";
import { isNotionAuthoritative } from "@/lib/platform";
import type { PostType } from "@/lib/platform-field-schemas";
import { cn } from "@/lib/utils";
import type {
  BrandAccount,
  CrossPostCandidate,
} from "@/lib/services/cross-post-candidates";

interface CrossPostTriageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidate: CrossPostCandidate;
  brandAccounts: BrandAccount[];
  brand: string;
  /** Per-source-format ranking of (target accountId, postType) pairs by
   *  historical cross-post count. The modal uses this to surface the most
   *  common targets first. Empty for formats with no cross-post history. */
  targetCommonality?: Record<
    string,
    Array<{ accountId: string; postType: string; count: number }>
  >;
  onActioned: () => void;
}

const VISIBLE_LIMIT = 8;

interface TargetPair {
  account: BrandAccount;
  postType: PostType;
  /** Existing cross-post production item for this (account, postType) pair, if any. */
  existing: { productionItemId: string; status: string | null } | null;
}

function pairKey(p: { account: { id: string }; postType: string }): string {
  return `${p.account.id}:${p.postType}`;
}

function platformSortIndex(platform: string): number {
  // Stable, semi-meaningful order: short-form first, then text, then long-form.
  const order = [
    "instagram",
    "tiktok",
    "youtube",
    "x",
    "threads",
    "linkedin",
    "newsletter",
    "other",
  ];
  const i = order.indexOf(platform);
  return i === -1 ? order.length : i;
}

export function CrossPostTriageDialog({
  open,
  onOpenChange,
  candidate,
  brandAccounts,
  brand,
  targetCommonality,
  onActioned,
}: CrossPostTriageDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Reset selection + collapse list when the candidate changes (or modal reopens).
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setShowAll(false);
    }
  }, [open, candidate.id]);

  const targets: TargetPair[] = useMemo(() => {
    const existingByPair = new Map(
      candidate.existingCrossPosts.map((x) => [
        `${x.accountId}:${x.postType ?? ""}`,
        { productionItemId: x.productionItemId, status: x.status },
      ])
    );
    const pairs: TargetPair[] = [];
    for (const acct of brandAccounts) {
      const supported = PLATFORM_META[toPlatform(acct.platform)].postTypes;
      for (const pt of supported) {
        // Skip the exact source pair — can't cross-post to itself.
        if (
          acct.id === candidate.account.id &&
          pt === candidate.postType
        ) {
          continue;
        }
        // Skip post types Notion owns (long-form YouTube). The cross-post
        // route would refuse to create one anyway. Note this is a per-
        // post-type filter, not per-account: a Notion-synced YouTube
        // channel still shows its `youtube_shorts` and `youtube_community`
        // options because those aren't Notion-owned.
        if (isNotionAuthoritative(pt)) continue;
        pairs.push({
          account: acct,
          postType: pt,
          existing: existingByPair.get(`${acct.id}:${pt}`) ?? null,
        });
      }
    }

    // Rank by historical popularity for this source's format. Pairs the
    // operator has reached for before in this format show up first; the
    // rest fall back to platform order. Pairs with an existing cross-post
    // sink to the bottom regardless — they're disabled so the active
    // checkable rows stay near the top.
    const ranking = candidate.format
      ? targetCommonality?.[candidate.format] ?? []
      : [];
    const rankIndex = new Map<string, number>();
    ranking.forEach((r, i) => rankIndex.set(`${r.accountId}:${r.postType}`, i));

    pairs.sort((a, b) => {
      const aDone = a.existing ? 1 : 0;
      const bDone = b.existing ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      const aKey = `${a.account.id}:${a.postType}`;
      const bKey = `${b.account.id}:${b.postType}`;
      const aRank = rankIndex.get(aKey) ?? Number.POSITIVE_INFINITY;
      const bRank = rankIndex.get(bKey) ?? Number.POSITIVE_INFINITY;
      if (aRank !== bRank) return aRank - bRank;
      const pa = platformSortIndex(a.account.platform);
      const pb = platformSortIndex(b.account.platform);
      if (pa !== pb) return pa - pb;
      const ah = a.account.handle.toLowerCase();
      const bh = b.account.handle.toLowerCase();
      if (ah !== bh) return ah.localeCompare(bh);
      return a.postType.localeCompare(b.postType);
    });
    return pairs;
  }, [brandAccounts, candidate, targetCommonality]);

  // Auto-expand if a hidden target ends up in the selection (e.g., user
  // expanded, picked, collapsed). Keeps the user's selections visible.
  const hasHiddenSelected = useMemo(() => {
    if (showAll || selected.size === 0) return false;
    for (let i = VISIBLE_LIMIT; i < targets.length; i++) {
      if (selected.has(`${targets[i].account.id}:${targets[i].postType}`))
        return true;
    }
    return false;
  }, [showAll, selected, targets]);

  const effectiveShowAll = showAll || hasHiddenSelected;
  const visibleTargets = effectiveShowAll
    ? targets
    : targets.slice(0, VISIBLE_LIMIT);
  const hiddenCount = targets.length - visibleTargets.length;

  function toggleOne(key: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleAll() {
    // Acts on the currently-visible targets so "Select all" while collapsed
    // doesn't quietly check the hidden ones.
    const selectableKeys = visibleTargets
      .filter((t) => !t.existing)
      .map((t) => pairKey(t));
    setSelected((prev) => {
      const allSelected =
        selectableKeys.length > 0 &&
        selectableKeys.every((k) => prev.has(k));
      if (allSelected) {
        const next = new Set(prev);
        for (const k of selectableKeys) next.delete(k);
        return next;
      }
      const next = new Set(prev);
      for (const k of selectableKeys) next.add(k);
      return next;
    });
  }

  async function handleSubmit() {
    const keys = Array.from(selected);
    setSubmitting(true);
    try {
      // Per-target outcome rolls up into the toast: created IDs go to the
      // success copy + link; 409s are treated as "already done" (no link
      // needed); thrown errors bubble as failures.
      const created: Array<{
        productionItemId: string;
        accountHandle: string;
      }> = [];
      let skipped = 0;
      let failed = 0;
      if (keys.length > 0) {
        const results = await Promise.allSettled(
          keys.map(async (key) => {
            const [accountId, postType] = key.split(":");
            const handle =
              targets.find((t) => pairKey(t) === key)?.account.handle ??
              "unknown";
            const res = await fetch(
              `/api/production-items/${candidate.id}/cross-post`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  targetAccountId: accountId,
                  targetPostType: postType,
                  assign: true,
                }),
              }
            );
            if (!res.ok) {
              // 409 = already exists for this pair → silently treat as
              // "already done" so the operator's intent ("I'm done with
              // this candidate") still completes.
              if (res.status === 409) return { kind: "skipped" as const };
              const err = (await res.json().catch(() => ({}))) as {
                error?: string;
              };
              throw new Error(err.error ?? `HTTP ${res.status}`);
            }
            const json = (await res.json().catch(() => ({}))) as {
              id?: string;
            };
            return {
              kind: "ok" as const,
              productionItemId: json.id ?? "",
              accountHandle: handle,
            };
          })
        );
        for (const r of results) {
          if (r.status === "fulfilled") {
            if (r.value.kind === "ok") created.push(r.value);
            else skipped++;
          } else failed++;
        }
        if (failed > 0 && created.length === 0) {
          toast.error(
            `Failed to cross-post (${failed} target${failed === 1 ? "" : "s"}).`
          );
          return;
        }
        showSubmitToast({ created, skipped, failed, brand });
      }

      // Always dismiss after a successful submit — the queue is a triage
      // surface, not a long-lived list. If the operator wants to revisit
      // this post later, they can find it via the content view.
      const dismissRes = await fetch(
        `/api/production-items/${candidate.id}/cross-post-dismiss`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      if (!dismissRes.ok) {
        // Non-fatal — the cross-posts already happened. Just warn.
        toast.warning("Cross-posts created, but failed to remove from queue.");
      }
      onOpenChange(false);
      onActioned();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to submit cross-posts"
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDismissOnly() {
    setDismissing(true);
    try {
      const res = await fetch(
        `/api/production-items/${candidate.id}/cross-post-dismiss`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(err.error || "Failed to dismiss");
        return;
      }
      toast(`Dismissed “${candidate.title || "candidate"}”`, {
        description: "Won't reappear for 30 days.",
        duration: 4000,
      });
      onOpenChange(false);
      onActioned();
    } finally {
      setDismissing(false);
    }
  }

  const visibleSelectableKeys = visibleTargets
    .filter((t) => !t.existing)
    .map((t) => pairKey(t));
  const allVisibleSelected =
    visibleSelectableKeys.length > 0 &&
    visibleSelectableKeys.every((k) => selected.has(k));
  const busy = submitting || dismissing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto gap-5">
        <DialogHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-900 border border-emerald-200"
              title="High-performing source content — pick where to cross-post it"
            >
              Hot
            </span>
            <AccountBadge
              account={candidate.account}
              postType={candidate.postType}
              variant="compact"
            />
            {candidate.format && (
              <span className="text-xs text-muted-foreground">
                · {candidate.format}
              </span>
            )}
          </div>
          <DialogTitle className="text-lg font-semibold pr-8">
            {candidate.title || "(Untitled)"}
          </DialogTitle>
        </DialogHeader>

        <section className="rounded-md border border-border bg-emerald-50/40 p-3 space-y-2">
          <div className="flex items-baseline justify-between flex-wrap gap-x-4 gap-y-1">
            <div className="text-sm text-foreground">
              <span className="font-semibold tabular-nums">
                {formatCompact(candidate.views)}
              </span>{" "}
              views ·{" "}
              <span className="font-medium text-foreground">
                {candidate.format}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {candidate.topSignal == null
                ? "New format — no cohort yet"
                : `${candidate.topSignal.ratio.toFixed(1)}× ${candidate.topSignal.kind}`}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground">Why this is hot:</span>{" "}
            {candidate.whyHot}
          </p>
          {candidate.hotnessSignals.length > 1 && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                Signal breakdown ({candidate.hotnessSignals.length})
              </summary>
              <ul className="mt-1 space-y-0.5 pl-3 tabular-nums">
                {candidate.hotnessSignals.map((s) => (
                  <li key={s.kind}>
                    <span className="font-medium text-foreground">
                      {s.label}:
                    </span>{" "}
                    {s.ratio.toFixed(2)}× ({formatCompact(s.views)} vs{" "}
                    {formatCompact(s.bar)} P
                    {Math.round(s.percentile * 100)} of {s.cohortLabel}, cohort{" "}
                    {s.cohortSize})
                    {s.cohortKind === "postType" && (
                      <span
                        className="ml-1 text-muted-foreground/70"
                        title="No cohort for this format yet — comparing against the broader post-type cohort"
                      >
                        ↩
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Cross-post to
            </h3>
            {visibleSelectableKeys.length > 0 && (
              <button
                type="button"
                onClick={toggleAll}
                disabled={busy}
                className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                title={
                  effectiveShowAll
                    ? "Toggle every visible row"
                    : `Toggle the top ${VISIBLE_LIMIT} most-common targets`
                }
              >
                {allVisibleSelected ? "Deselect all" : "Select all"}
              </button>
            )}
          </div>
          {targets.length === 0 ? (
            <div className="text-sm text-muted-foreground rounded-md border border-border bg-muted/40 p-3">
              No other accounts on this brand to cross-post to.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {visibleTargets.map((t) => {
                const key = pairKey(t);
                const isDone = !!t.existing;
                const isChecked = selected.has(key);
                return (
                  <label
                    key={key}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md border bg-background px-3 py-2.5 transition-colors",
                      isDone
                        ? "border-border opacity-60 cursor-not-allowed"
                        : "border-input cursor-pointer hover:border-foreground/40 hover:bg-accent/40",
                      isChecked && !isDone && "border-emerald-500 bg-emerald-50/40"
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-4 rounded border-input cursor-pointer accent-emerald-600 disabled:cursor-not-allowed"
                      checked={isChecked}
                      disabled={isDone || busy}
                      onChange={(e) => toggleOne(key, e.target.checked)}
                    />
                    <span className="flex-1 min-w-0 inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
                      <AccountAvatar
                        avatarUrl={t.account.avatarUrl ?? null}
                        platform={t.account.platform}
                        handle={t.account.handle}
                        size={20}
                      />
                      <span className="font-medium text-foreground truncate">
                        @{t.account.handle}
                      </span>
                      <span className="text-muted-foreground">
                        ·{" "}
                        {POST_TYPE_SHORT_LABEL[t.postType] ??
                          PLATFORM_META[toPlatform(t.account.platform)].label}
                      </span>
                    </span>
                    {isDone && (
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap uppercase tracking-wider">
                        {t.existing?.status ?? "done"}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
          {targets.length > VISIBLE_LIMIT && (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                disabled={hasHiddenSelected}
                className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                title={
                  hasHiddenSelected
                    ? "Hidden rows are selected — uncheck them to collapse"
                    : effectiveShowAll
                    ? "Hide less-common targets"
                    : "Show every (account, post type) combination on this brand"
                }
              >
                {effectiveShowAll
                  ? "Show fewer"
                  : `Show all (${targets.length - VISIBLE_LIMIT} more)`}
              </button>
            </div>
          )}
        </section>

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={busy || selected.size === 0}
          className={cn(
            "h-10 w-full rounded-md text-sm font-medium transition-colors",
            "bg-emerald-600 text-white hover:bg-emerald-700",
            "disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
          )}
          title={
            selected.size === 0
              ? "Pick at least one target"
              : "Create assigned cross-post drafts and remove this from the queue"
          }
        >
          {submitting
            ? "Cross-posting…"
            : selected.size === 0
            ? "Cross-post selected"
            : `Cross-post ${selected.size} selected`}
        </button>

        <div className="flex items-center justify-between border-t border-border pt-3">
          <button
            type="button"
            onClick={() => void handleDismissOnly()}
            disabled={busy}
            className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Not interested
          </button>
          <div className="flex items-center gap-3">
            {candidate.publishedLink && (
              <a
                href={candidate.publishedLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                See source post
                <ExternalLinkIcon className="size-3" />
              </a>
            )}
            <Link
              href={`/${brand}/content/${candidate.id}`}
              target="_blank"
              className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              Open full page
              <ExternalLinkIcon className="size-3" />
            </Link>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

// Toast UX after a Cross-post submit. Spells out what was created and where
// it lives:
//   - 1 created → "Created an Assigned cross-post draft on @handle." with a
//     deep link to that production item's detail page.
//   - N created → "Created N Assigned cross-post drafts." with a link into
//     the production view (where they sit in the Assigned column).
//   - mixed success/skipped/failed → same shape, plus a description line
//     summarizing the breakdown.
function showSubmitToast(args: {
  created: Array<{ productionItemId: string; accountHandle: string }>;
  skipped: number;
  failed: number;
  brand: string;
}) {
  const { created, skipped, failed, brand } = args;
  const okCount = created.length;
  if (okCount === 0 && skipped === 0) {
    // All failed — handled by the caller's error path.
    return;
  }

  const breakdown: string[] = [];
  if (okCount > 0)
    breakdown.push(`${okCount} new draft${okCount === 1 ? "" : "s"}`);
  if (skipped > 0)
    breakdown.push(`${skipped} already existed`);
  if (failed > 0) breakdown.push(`${failed} failed`);

  if (okCount === 1) {
    const only = created[0];
    toast.success(
      `Created an Assigned cross-post draft on @${only.accountHandle}.`,
      {
        description: [
          breakdown.join(" · "),
          "It's now in Production → Assigned, ready for the editor.",
        ]
          .filter(Boolean)
          .join("\n"),
        action: only.productionItemId
          ? {
              label: "Open draft →",
              onClick: () =>
                window.open(
                  `/${brand}/content/${only.productionItemId}`,
                  "_blank",
                  "noopener"
                ),
            }
          : undefined,
        duration: 7000,
      }
    );
    return;
  }

  if (okCount > 1) {
    toast.success(
      `Created ${okCount} Assigned cross-post drafts.`,
      {
        description: [
          breakdown.join(" · "),
          "Each lands in Production → Assigned, ready for an editor.",
        ]
          .filter(Boolean)
          .join("\n"),
        action: {
          label: "Open production →",
          onClick: () =>
            window.open(`/${brand}/production`, "_blank", "noopener"),
        },
        duration: 7000,
      }
    );
    return;
  }

  // okCount === 0 but skipped > 0 — every selected target already had a
  // cross-post. Inform without claiming we created anything.
  toast(
    `Already cross-posted (${skipped} target${skipped === 1 ? "" : "s"}).`,
    {
      description: "Removing this candidate from the queue.",
      duration: 5000,
    }
  );
}
