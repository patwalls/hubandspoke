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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AccountAvatar } from "@/components/ui/account-avatar";
import { AccountBadge } from "@/components/ui/account-badge";
import { UserChip } from "./user-chip";
import {
  PLATFORM_META,
  POST_TYPE_SHORT_LABEL,
  toPlatform,
} from "@/lib/platforms";
import { isNotionAuthoritative } from "@/lib/platform";
import {
  PLATFORM_FIELD_SCHEMAS,
  type PlatformKey,
  type PostType,
} from "@/lib/platform-field-schemas";
import { cn } from "@/lib/utils";
import type { BrandAccount } from "@/lib/services/cross-post-candidates";
import { PreviewEmbed } from "./preview/embed";

/** "3d ago", "2h ago", "just now" — short relative-time helper for the
 *  "Already posted · Xd ago" hint on a cross-post target row. Same shape
 *  as the helper in `sync-errors-table.tsx`; inlined here because there's
 *  no shared utils file for "time-ago" yet and a 10-line helper isn't
 *  worth a new module. */
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}

/** Subset of `CrossPostCandidate` the dialog actually consumes. The queue
 *  passes a full candidate (with hotness signals + dismiss-after-submit
 *  behavior); the content-detail page synthesizes a minimal one for the
 *  "Cross-post to…" action menu. Optional fields suppress queue-only UI
 *  (the "Hot" badge, the "Why this is hot" stats block) so the dialog
 *  works for both callers without two implementations. */
export interface CrossPostTriageDialogCandidate {
  id: string;
  brand: string;
  title: string | null;
  postType: string;
  format: string | null;
  account: {
    id: string;
    platform: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  existingCrossPosts: Array<{
    productionItemId: string;
    accountId: string;
    postType: string | null;
    status: string | null;
    publishedAt: string | null;
  }>;
  publishedLink?: string | null;
  /** Queue-only: views at the time the candidate was scored. */
  views?: number | null;
  /** Queue-only: top hotness signal, drives the "1.4× 2h" badge. */
  topSignal?: { ratio: number; kind: string } | null;
  /** Queue-only: every signal we could compute. Empty / undefined hides
   *  the signal breakdown disclosure. */
  hotnessSignals?: Array<{
    kind: string;
    label: string;
    ratio: number;
    views: number;
    bar: number;
    percentile: number;
    cohortLabel: string;
    cohortSize: number;
    cohortKind: string;
  }>;
  /** Queue-only: "Above average — 1.4× the typical pace …" copy. When
   *  undefined the "Hot" badge + Why-this-is-hot block are hidden. */
  whyHot?: string;
}

interface CrossPostTriagePanelProps {
  candidate: CrossPostTriageDialogCandidate;
  brandAccounts: BrandAccount[];
  brand: string;
  /** Per-source-format ranking of (target accountId, postType) pairs by
   *  historical cross-post count. The panel uses this to surface the most
   *  common targets first. Empty for formats with no cross-post history. */
  targetCommonality?: Record<
    string,
    Array<{ accountId: string; postType: string; count: number }>
  >;
  /** Default true — queue triage dismisses the candidate from the queue
   *  after a successful submit so it doesn't reappear tomorrow. Pass
   *  `false` when the panel is rendered from a non-queue surface (e.g.
   *  the per-item content-detail tab); cross-posting from there shouldn't
   *  hide the source from the hot queue. */
  dismissAfterSubmit?: boolean;
  /** Whether to show the source title + Hot pill + AccountBadge header.
   *  Dialogs include their own DialogTitle so they hide this; the tab
   *  embed shows it (above the content-detail page title would be
   *  redundant, so we drop the visual heading too — only the metadata
   *  pill row stays). */
  showSourceHeader?: boolean;
  /** Whether to show the "Not interested" + "Open full page" / "See
   *  source post" footer row. Dialogs need it (the user might want to
   *  open the source page); inline tabs hide it (they're already on the
   *  source page). */
  showSecondaryFooter?: boolean;
  /** Called after a successful submit. Dialogs pass
   *  `() => onOpenChange(false)`; tabs pass nothing — the panel just
   *  clears its own selection state and stays mounted. */
  onSubmitted?: () => void;
  onActioned: () => void;
}

interface CrossPostTriageDialogProps
  extends Omit<CrossPostTriagePanelProps, "showSourceHeader" | "showSecondaryFooter" | "onSubmitted"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const VISIBLE_LIMIT = 8;

interface TargetPair {
  account: BrandAccount;
  postType: PostType;
  /** Existing cross-post production item for this (account, postType) pair, if any.
   *  May be a sibling deeper in the lineage tree (e.g., the candidate is a
   *  repost of the original; the row here is a cross-post of the original). */
  existing: {
    productionItemId: string;
    status: string | null;
    publishedAt: string | null;
  } | null;
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

/** Per-target gate failure that survives in dialog state so we can render
 *  the "I'll do it manually" affordance inline (instead of a toast that
 *  drops the user back at the dialog with no recoverable action). */
interface GateFailure {
  key: string;
  accountHandle: string;
  postType: PostType;
  /** Stable identifier from the route's 400 response — `needs_transcript`,
   *  `needs_pillar_media`, `needs_source_media`. Used to decide whether to
   *  offer manual-handoff (true for all gateable reasons, since the row
   *  itself is still creatable). */
  reason: string | null;
  message: string;
}

export function CrossPostTriagePanel({
  candidate,
  brandAccounts,
  brand,
  targetCommonality,
  dismissAfterSubmit = true,
  showSourceHeader = true,
  showSecondaryFooter = true,
  onSubmitted,
  onActioned,
}: CrossPostTriagePanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [assigneeUserId, setAssigneeUserId] = useState<string>("");
  const [gateFailures, setGateFailures] = useState<GateFailure[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<
    Array<{ id: string; name: string | null; email: string; avatarUrl: string | null }>
  >([]);

  // Reset selection when the candidate changes. The panel stays mounted in
  // tab mode so we can't rely on the dialog's open/close lifecycle; the
  // candidate id is the source-of-truth boundary instead.
  useEffect(() => {
    setSelected(new Set());
    setShowAll(false);
    setAssigneeUserId("");
    setGateFailures([]);
  }, [candidate.id]);

  /** Common cleanup after a successful submit / dismiss: clear in-flight
   *  selection so the panel returns to a clean state, then signal the
   *  parent to close the wrapping dialog (if any). Tab embeds pass no
   *  `onSubmitted` and just stay mounted with cleared state. */
  function clearAndClose() {
    setSelected(new Set());
    setAssigneeUserId("");
    setGateFailures([]);
    onSubmitted?.();
  }

  // Fetch assignable users once. List rarely changes during a triage
  // session, so the result stays cached across candidate flips.
  useEffect(() => {
    if (assignableUsers.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/users/assignable");
        if (!res.ok) return;
        const json = (await res.json()) as {
          users: Array<{
            id: string;
            name: string | null;
            email: string;
            avatarUrl: string | null;
          }>;
        };
        if (!cancelled) setAssignableUsers(json.users ?? []);
      } catch {
        // Non-fatal — picker just won't have options; user sees an empty
        // dropdown and the disabled CTA blocks submit.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignableUsers.length]);

  const targets: TargetPair[] = useMemo(() => {
    const existingByPair = new Map(
      candidate.existingCrossPosts.map((x) => [
        `${x.accountId}:${x.postType ?? ""}`,
        {
          productionItemId: x.productionItemId,
          status: x.status,
          publishedAt: x.publishedAt,
        },
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

  /** Inner per-target submitter shared by the primary "Cross-post N
   *  selected" handler and the "I'll do it manually" retry. When `manual`
   *  is true the route skips the readiness gate AND skips the
   *  descript-derivative-create enqueue — the row is created empty for the
   *  operator to attach media to themselves. */
  async function submitTargets(
    keys: string[],
    opts: { manual: boolean },
  ): Promise<{
    created: Array<{ productionItemId: string; accountHandle: string }>;
    skipped: number;
    gateFailures: GateFailure[];
    hardErrors: string[];
  }> {
    const created: Array<{ productionItemId: string; accountHandle: string }> = [];
    let skipped = 0;
    const gateFails: GateFailure[] = [];
    const hardErrors: string[] = [];
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
              editorUserId: assigneeUserId,
              manual: opts.manual,
            }),
          }
        );
        if (!res.ok) {
          // 409 = already exists for this pair → silently treat as
          // "already done" so the operator's intent ("I'm done with
          // this candidate") still completes.
          if (res.status === 409) return { kind: "skipped" as const, key };
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
            reason?: string;
          };
          // 400 with a `reason` is a known readiness failure — the operator
          // can still recover via "I'll do it manually". Surface it
          // separately from hard errors so the UI knows to offer that
          // affordance instead of just a toast dead-end.
          if (res.status === 400 && err.reason) {
            return {
              kind: "gate" as const,
              key,
              gate: {
                key,
                accountHandle: handle,
                postType: postType as PostType,
                reason: err.reason,
                message: err.error ?? "Cross-post refused by readiness gate.",
              },
            };
          }
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json().catch(() => ({}))) as {
          id?: string;
        };
        return {
          kind: "ok" as const,
          key,
          productionItemId: json.id ?? "",
          accountHandle: handle,
        };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.kind === "ok") {
          created.push({
            productionItemId: r.value.productionItemId,
            accountHandle: r.value.accountHandle,
          });
        } else if (r.value.kind === "skipped") {
          skipped++;
        } else {
          gateFails.push(r.value.gate);
        }
      } else {
        const message =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        if (message && !hardErrors.includes(message)) hardErrors.push(message);
      }
    }
    return { created, skipped, gateFailures: gateFails, hardErrors };
  }

  async function handleSubmit() {
    const keys = Array.from(selected);
    setSubmitting(true);
    setGateFailures([]);
    try {
      if (keys.length === 0) return;
      const {
        created,
        skipped,
        gateFailures: gateFails,
        hardErrors,
      } = await submitTargets(keys, { manual: false });
      const failed = gateFails.length + hardErrors.length;

      // Anything refused by the readiness gate stays in the dialog with an
      // inline banner + "I'll do it manually" button. The operator can
      // either run transcription and retry, or click manual to create the
      // rows anyway and upload by hand. Hard errors (route 500, network,
      // 401) still toast — they're not actionable in-dialog.
      if (gateFails.length > 0) {
        setGateFailures(gateFails);
        if (created.length > 0 || skipped > 0) {
          showSubmitToast({ created, skipped, failed, brand });
        }
        if (hardErrors.length > 0) {
          toast.error(hardErrors.slice(0, 2).join("\n\n"), {
            duration: 10_000,
          });
        }
        return;
      }

      if (created.length === 0 && hardErrors.length > 0) {
        toast.error(
          `Failed to cross-post (${hardErrors.length} target${hardErrors.length === 1 ? "" : "s"}).`,
          { description: hardErrors.slice(0, 2).join("\n\n"), duration: 12_000 },
        );
        return;
      }
      showSubmitToast({ created, skipped, failed, brand });

      // Dismiss the source from the hot queue after a successful submit —
      // the queue is a triage surface, not a long-lived list. Suppressed
      // when the dialog is fired from a non-queue surface (per-item
      // Actions menu) since dismissing would silently hide the source
      // from a list the operator never saw.
      if (dismissAfterSubmit) {
        const dismissRes = await fetch(
          `/api/production-items/${candidate.id}/cross-post-dismiss`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }
        );
        if (!dismissRes.ok) {
          toast.warning("Cross-posts created, but failed to remove from queue.");
        }
      }
      clearAndClose();
      onActioned();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to submit cross-posts"
      );
    } finally {
      setSubmitting(false);
    }
  }

  /** Retry just the gate-failed targets with `manual: true`. The route
   *  bypasses the readiness gate AND skips enqueuing Descript work — the
   *  row is created so it shows up in the workflow, and the operator
   *  attaches media themselves. */
  async function handleManualSubmit() {
    const keys = gateFailures.map((f) => f.key);
    if (keys.length === 0) return;
    setManualSubmitting(true);
    try {
      const { created, skipped, hardErrors } = await submitTargets(keys, {
        manual: true,
      });
      if (hardErrors.length > 0 && created.length === 0) {
        toast.error(hardErrors.slice(0, 2).join("\n\n"), { duration: 10_000 });
        return;
      }
      if (created.length > 0) {
        toast.success(
          created.length === 1
            ? `Manual cross-post row created on @${created[0].accountHandle}.`
            : `Created ${created.length} manual cross-post rows.`,
          {
            description: "No Descript prep — upload the media yourself when ready.",
            duration: 6000,
          },
        );
      }
      setGateFailures([]);
      // Dismiss + close, same as the happy path. Skipped when the dialog
      // is fired from a non-queue surface — see the rationale in
      // handleSubmit above.
      if (dismissAfterSubmit) {
        await fetch(
          `/api/production-items/${candidate.id}/cross-post-dismiss`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }
        ).catch(() => {});
      }
      clearAndClose();
      onActioned();
      void skipped;
    } finally {
      setManualSubmitting(false);
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
      clearAndClose();
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
  const busy = submitting || dismissing || manualSubmitting;
  // Queue-only "Hot" badge + stats block. Hidden when the dialog is fired
  // from a non-queue surface (per-item Actions menu) where there's no
  // hotness scoring to show.
  const showHotnessSection = !!candidate.whyHot;

  return (
    <div className="flex flex-col gap-5">
      {showSourceHeader && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            {showHotnessSection && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-900 border border-emerald-200"
                title="High-performing source content — pick where to cross-post it"
              >
                Hot
              </span>
            )}
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
          <h2 className="text-lg font-semibold pr-8">
            {candidate.title || "(Untitled)"}
          </h2>
        </div>
      )}

        {showHotnessSection && (
        <section className="rounded-md border border-border bg-emerald-50/40 p-3 space-y-2">
          <div className="flex items-baseline justify-between flex-wrap gap-x-4 gap-y-1">
            <div className="text-sm text-foreground">
              <span className="font-semibold tabular-nums">
                {formatCompact(candidate.views ?? null)}
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
          {(candidate.hotnessSignals?.length ?? 0) > 1 && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                Signal breakdown ({candidate.hotnessSignals!.length})
              </summary>
              <ul className="mt-1 space-y-0.5 pl-3 tabular-nums">
                {candidate.hotnessSignals!.map((s) => (
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
        )}

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
                      <span
                        className="text-[10px] text-muted-foreground whitespace-nowrap"
                        title={
                          t.existing?.publishedAt
                            ? `Already cross-posted on ${new Date(t.existing.publishedAt).toLocaleString()}`
                            : `Already cross-posted (status: ${t.existing?.status ?? "unknown"})`
                        }
                      >
                        {t.existing?.publishedAt
                          ? `Already posted · ${timeAgo(t.existing.publishedAt)}`
                          : `Already cross-posted · ${(t.existing?.status ?? "in progress").toLowerCase()}`}
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

        <section className="space-y-2">
          <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
            Assign to
          </div>
          <Select
            value={assigneeUserId || ""}
            onValueChange={(v) => setAssigneeUserId(v ?? "")}
            disabled={busy}
          >
            <SelectTrigger
              aria-label="Assignee"
              className="h-10 [&>span]:flex [&>span]:items-center [&>span]:min-w-0 [&>span]:flex-1"
            >
              {assigneeUserId ? (
                (() => {
                  const u = assignableUsers.find((x) => x.id === assigneeUserId);
                  return u ? (
                    <UserChip user={u} />
                  ) : (
                    <SelectValue placeholder="Select an editor" />
                  );
                })()
              ) : (
                <span className="text-muted-foreground">Select an editor…</span>
              )}
            </SelectTrigger>
            <SelectContent>
              {assignableUsers.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  <UserChip user={u} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>

        {gateFailures.length > 0 && (
          <section className="rounded-md border border-amber-300 bg-amber-50/60 p-3 space-y-2">
            <div className="text-sm font-semibold text-amber-900">
              Can&apos;t auto-prep {gateFailures.length === 1 ? "this cross-post" : `${gateFailures.length} cross-posts`}.
            </div>
            <ul className="text-[12px] text-amber-900/90 space-y-1.5 list-disc pl-5">
              {gateFailures.slice(0, 3).map((f) => (
                <li key={f.key}>
                  <span className="font-medium">
                    @{f.accountHandle} · {POST_TYPE_SHORT_LABEL[f.postType] ?? f.postType}
                  </span>
                  {" — "}
                  {f.message}
                </li>
              ))}
              {gateFailures.length > 3 && (
                <li className="text-amber-900/70">
                  …and {gateFailures.length - 3} more with the same reason.
                </li>
              )}
            </ul>
            <p className="text-[12px] text-amber-900/80">
              Two options: re-run enrichment on the source so it has an
              archived video, or skip the automation and upload manually.
            </p>
            <button
              type="button"
              onClick={() => void handleManualSubmit()}
              disabled={busy}
              className={cn(
                "h-9 w-full rounded-md text-sm font-medium transition-colors",
                "bg-amber-600 text-white hover:bg-amber-700",
                "disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
              )}
              title="Create the cross-post rows without Descript prep. You'll attach media manually."
            >
              {manualSubmitting
                ? "Creating manual rows…"
                : `I'll do it manually (${gateFailures.length})`}
            </button>
          </section>
        )}

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={busy || selected.size === 0 || !assigneeUserId}
          className={cn(
            "h-10 w-full rounded-md text-sm font-medium transition-colors",
            "bg-emerald-600 text-white hover:bg-emerald-700",
            "disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
          )}
          title={
            selected.size === 0
              ? "Pick at least one target"
              : !assigneeUserId
              ? "Pick an editor first"
              : "Create cross-post drafts in Ready To Publish and remove this from the queue"
          }
        >
          {submitting
            ? "Cross-posting…"
            : selected.size === 0
            ? "Cross-post selected"
            : !assigneeUserId
            ? "Pick an editor to continue"
            : `Cross-post ${selected.size} selected`}
        </button>

        {showSecondaryFooter && (
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
        )}
    </div>
  );
}

/** Thin Dialog wrapper around `CrossPostTriagePanel`. Use this from
 *  surfaces that want the modal behavior (the hot queue table). For
 *  inline embedding (a content-detail tab), render the panel directly. */
export function CrossPostTriageDialog({
  open,
  onOpenChange,
  ...panelProps
}: CrossPostTriageDialogProps) {
  // Show a Live-post column on the left whenever the source has a
  // publishedLink AND a recognized platform key. Skip when either is
  // missing — falls back to the original single-column layout so the
  // dialog doesn't grow uselessly wide for unembed-able sources.
  const livePlatform: PlatformKey | null =
    panelProps.candidate.postType &&
    panelProps.candidate.postType in PLATFORM_FIELD_SCHEMAS
      ? (panelProps.candidate.postType as PlatformKey)
      : null;
  const showLivePreview =
    !!panelProps.candidate.publishedLink && livePlatform !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-h-[90vh] overflow-y-auto gap-5",
          showLivePreview ? "sm:max-w-5xl" : "sm:max-w-3xl",
        )}
      >
        {/* The panel renders its own visual title block; the DialogTitle
         *  here is sr-only so Radix's a11y contract is satisfied without
         *  duplicating the heading. */}
        <DialogHeader className="sr-only">
          <DialogTitle>
            {panelProps.candidate.title || "Cross-post"}
          </DialogTitle>
        </DialogHeader>
        {showLivePreview && livePlatform ? (
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
            <aside className="min-w-0">
              <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-2">
                Live post
              </div>
              <PreviewEmbed
                platform={livePlatform}
                publishedLink={panelProps.candidate.publishedLink ?? null}
                newsletterBodyHtml={null}
              />
            </aside>
            <div className="min-w-0">
              <CrossPostTriagePanel
                {...panelProps}
                onSubmitted={() => onOpenChange(false)}
              />
            </div>
          </div>
        ) : (
          <CrossPostTriagePanel
            {...panelProps}
            onSubmitted={() => onOpenChange(false)}
          />
        )}
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
