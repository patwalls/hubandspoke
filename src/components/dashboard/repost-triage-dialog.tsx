"use client";

import { useEffect, useState } from "react";
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
import { AccountBadge } from "@/components/ui/account-badge";
import { UserChip } from "./user-chip";
import { KillIdeaDialog } from "./kill-idea-dialog";
import { cn } from "@/lib/utils";
import {
  PLATFORM_FIELD_SCHEMAS,
  type PlatformKey,
} from "@/lib/platform-field-schemas";
import { PreviewEmbed } from "./preview/embed";
/** Subset of `RepostCandidate` the dialog actually consumes. The queue
 *  triage path passes a full candidate (with hotness signals + evergreen
 *  reasoning + prior reposts); the content-detail Actions menu synthesizes
 *  a minimal one. Optional fields suppress queue-only UI sections. */
export interface RepostTriageDialogCandidate {
  id: string;
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
  publishedLink?: string | null;
  views?: number | null;
  /** Queue-only: drives the "1.4× this account" badge. */
  topSignal?: {
    ratio: number;
    cohortKind: "account" | "brand" | "format";
  } | null;
  /** Queue-only: "Above average — 1.4× the typical pace …" copy. When
   *  undefined the "Hot" badge + Why-this-is-hot block are hidden. */
  whyHot?: string;
  /** Queue-only: every signal we could compute. */
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
  /** Queue-only: evergreen scoring reasoning. */
  evergreenReasoning?: string | null;
  /** Queue-only: sibling reposts list. */
  priorReposts?: Array<{
    productionItemId: string;
    status: string | null;
    publishedAt: string | null;
    publishedDate?: string | null;
    views?: number | null;
    likes?: number | null;
  }>;
}

interface RepostTriagePanelProps {
  candidate: RepostTriageDialogCandidate;
  brand: string;
  /** Default true — show "Not interested" + "Kill" dismiss controls.
   *  Pass `false` when the panel is rendered from a non-queue surface
   *  (content-detail tab): there's no queue entry to dismiss, and
   *  killing an idea you opened intentionally is nonsense. */
  showDismissControls?: boolean;
  /** Default true — show the source title + Hot pill block. Inline tabs
   *  hide it because the content-detail page already shows the title
   *  right above. */
  showSourceHeader?: boolean;
  /** Default true — show the "See source post" / "Open full page"
   *  footer row. Inline tabs hide it (we're already on the source). */
  showSecondaryFooter?: boolean;
  /** Called after a successful submit. Dialogs pass
   *  `() => onOpenChange(false)`; tabs pass nothing — the panel stays
   *  mounted with cleared state. */
  onSubmitted?: () => void;
  onActioned: () => void;
}

interface RepostTriageDialogProps
  extends Omit<RepostTriagePanelProps, "showSourceHeader" | "showSecondaryFooter" | "onSubmitted"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RepostTriagePanel({
  candidate,
  brand,
  showDismissControls = true,
  showSourceHeader = true,
  showSecondaryFooter = true,
  onSubmitted,
  onActioned,
}: RepostTriagePanelProps) {
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [assigneeUserId, setAssigneeUserId] = useState<string>("");
  const [assignableUsers, setAssignableUsers] = useState<
    Array<{ id: string; name: string | null; email: string; avatarUrl: string | null }>
  >([]);

  // Reset the assignee picker when the candidate changes. Panel stays
  // mounted in tab mode, so we hang the reset off candidate.id (not the
  // dialog's open/close).
  useEffect(() => {
    setAssigneeUserId("");
  }, [candidate.id]);

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
        // Non-fatal — picker just won't have options.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignableUsers.length]);

  /** Cleanup after a successful submit — clear selection, then signal the
   *  parent to close the dialog (if any). Tab embeds stay mounted with
   *  cleared state. */
  function clearAndClose() {
    setAssigneeUserId("");
    onSubmitted?.();
  }

  async function handleRepost() {
    if (!assigneeUserId) return;
    // Belt-and-suspenders re-entry guard. The button disables on
    // `submitting`, but a fast double-click can still queue two clicks
    // before React commits the disabled state.
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/production-items/${candidate.id}/repost`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            editorUserId: assigneeUserId,
            status: "Ready To Publish",
          }),
        }
      );
      const json = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(json.error || `HTTP ${res.status}`);
        return;
      }
      const newId = json.id ?? null;
      toast.success("Repost queued.", {
        description: "Lands in Ready To Publish for the editor.",
        action: newId
          ? {
              label: "Open draft →",
              onClick: () =>
                window.open(`/${brand}/content/${newId}`, "_blank", "noopener"),
            }
          : undefined,
        duration: 7000,
      });
      clearAndClose();
      onActioned();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDismissOnly() {
    setDismissing(true);
    try {
      const res = await fetch(
        `/api/production-items/${candidate.id}/repost-dismiss`,
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

  async function handleKill(reason: string) {
    setDismissing(true);
    try {
      // "Kill" on a v2 candidate = a *permanent* dismiss with a reason.
      // No corresponding production_item exists yet, so we can't flip a
      // status. Instead we write the dismissal event with the reason —
      // selectRepostCandidates surfaces it via the 30d hide-list, and
      // a future "permanent kill" upgrade can extend the TTL or add a
      // separate event type.
      const res = await fetch(
        `/api/production-items/${candidate.id}/repost-dismiss`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(err.error || "Failed to kill");
        return;
      }
      toast(`Killed “${candidate.title || "candidate"}”`, {
        description: "Won't reappear for 30 days.",
        duration: 4000,
      });
      setKillOpen(false);
      clearAndClose();
      onActioned();
    } finally {
      setDismissing(false);
    }
  }

  const busy = submitting || dismissing;
  // Queue-only "Hot" badge + stats / evergreen / prior-reposts sections.
  // Suppressed when the dialog is fired from the per-item Actions menu
  // where there's no hotness scoring to display.
  const showHotnessSection = !!candidate.whyHot;
  const top = candidate.topSignal ?? null;

  return (
    <>
      <div className="flex flex-col gap-5">
          {showSourceHeader && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap">
              {showHotnessSection && (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-900 border border-emerald-200"
                  title="Elite evergreen — clears the format×account top quartile by 1.5×+"
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
              {top && (
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {top.ratio.toFixed(1)}× {top.cohortKind === "account"
                  ? "this account"
                  : top.cohortKind === "brand"
                    ? "this brand"
                    : "format-wide"}
              </div>
              )}
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
                      {s.cohortKind !== "account" && (
                        <span
                          className="ml-1 text-muted-foreground/70"
                          title={
                            s.cohortKind === "brand"
                              ? "Account didn't have enough items in this format yet — comparing brand-wide"
                              : "Neither account nor brand had enough items — falling back to cross-brand"
                          }
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

          {candidate.evergreenReasoning && (
            <section className="rounded-md border border-amber-200 bg-amber-50/50 p-3">
              <div className="text-[10px] font-mono uppercase tracking-wider text-amber-800 mb-1">
                Evergreen note
              </div>
              <p className="text-sm text-foreground leading-snug">
                {candidate.evergreenReasoning}
              </p>
            </section>
          )}

          {(candidate.priorReposts?.length ?? 0) > 0 && (
            <section className="rounded-md border border-border bg-muted/30 p-3 text-xs space-y-1">
              <div className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Prior reposts ({candidate.priorReposts!.length})
              </div>
              {candidate.priorReposts!.slice(0, 4).map((r) => {
                // Date fallback: prefer the precise publishedAt timestamp,
                // fall back to publishedDate (date column) which older synced
                // rows often have when publishedAt is null.
                const dateIso = r.publishedAt ?? r.publishedDate ?? null;
                const dateLabel = dateIso
                  ? new Date(dateIso).toLocaleDateString()
                  : null;
                return (
                  <div key={r.productionItemId} className="text-muted-foreground">
                    <Link
                      href={`/${brand}/content/${r.productionItemId}`}
                      target="_blank"
                      className="hover:underline"
                    >
                      {r.status}
                    </Link>
                    {dateLabel && <span> · {dateLabel}</span>}
                    {r.views != null && r.views > 0 && (
                      <span> · {formatCompact(r.views)} views</span>
                    )}
                    {r.likes != null && r.likes > 0 && (
                      <span> · {formatCompact(r.likes)} likes</span>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          <section className="space-y-2">
            <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              Assign editor
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

          <button
            type="button"
            onClick={() => void handleRepost()}
            disabled={busy || !assigneeUserId}
            className={cn(
              "h-10 w-full rounded-md text-sm font-medium transition-colors",
              "bg-emerald-600 text-white hover:bg-emerald-700",
              "disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
            )}
            title={
              !assigneeUserId
                ? "Pick an editor first"
                : "Create a repost draft in Ready To Publish"
            }
          >
            {submitting
              ? "Queueing repost…"
              : !assigneeUserId
                ? "Pick an editor to continue"
                : "Repost it"}
          </button>

          {(showDismissControls || showSecondaryFooter) && (
          <div className="flex items-center justify-between border-t border-border pt-3">
            <div className="flex items-center gap-3">
              {showDismissControls && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleDismissOnly()}
                    disabled={busy}
                    className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    Not interested
                  </button>
                  <button
                    type="button"
                    onClick={() => setKillOpen(true)}
                    disabled={busy}
                    className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
                  >
                    Kill this idea
                  </button>
                </>
              )}
            </div>
            {showSecondaryFooter && (
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
            )}
          </div>
          )}
      </div>

      <KillIdeaDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        title={candidate.title || "(Untitled)"}
        onConfirm={handleKill}
      />
    </>
  );
}

/** Thin Dialog wrapper around `RepostTriagePanel`. Use from surfaces that
 *  want modal behavior (the hot queue table). For inline embedding (a
 *  content-detail tab), render the panel directly. */
export function RepostTriageDialog({
  open,
  onOpenChange,
  ...panelProps
}: RepostTriageDialogProps) {
  // Mirror the cross-post dialog: show a Live-post column on the left when
  // the source has a publishedLink AND a recognized platform key.
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
          showLivePreview ? "sm:max-w-5xl" : "sm:max-w-2xl",
        )}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>
            {panelProps.candidate.title || "Repost"}
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
              <RepostTriagePanel
                {...panelProps}
                onSubmitted={() => onOpenChange(false)}
              />
            </div>
          </div>
        ) : (
          <RepostTriagePanel
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
