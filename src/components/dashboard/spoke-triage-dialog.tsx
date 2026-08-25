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
import { UserCombobox } from "./user-combobox";
import { KillIdeaDialog } from "./kill-idea-dialog";
import { cn } from "@/lib/utils";
import type { SpokeCandidate } from "@/lib/services/spoke-candidates";

interface SpokeTriageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidate: SpokeCandidate;
  brand: string;
  onActioned: () => void;
}

function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

export function SpokeTriageDialog({
  open,
  onOpenChange,
  candidate,
  brand,
  onActioned,
}: SpokeTriageDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [assigneeUserId, setAssigneeUserId] = useState<string>("");
  const [assignableUsers, setAssignableUsers] = useState<
    Array<{ id: string; name: string | null; email: string; avatarUrl: string | null }>
  >([]);

  // Reset the picker whenever a different pair opens in the dialog.
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

  const busy = submitting || dismissing;

  async function handleRepurpose() {
    if (!assigneeUserId) return;
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/production-items/${candidate.pillar.id}/repurpose`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetFormatId: candidate.format.id,
            editorUserId: assigneeUserId,
          }),
        },
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
      toast.success(`Repurpose queued — ${candidate.format.name}`, {
        description: "Lands in Assigned for the editor to draft.",
        action: newId
          ? {
              label: "Open draft →",
              onClick: () =>
                window.open(
                  `/${brand}/content/${newId}`,
                  "_blank",
                  "noopener",
                ),
            }
          : undefined,
        duration: 7000,
      });
      onOpenChange(false);
      onActioned();
    } finally {
      setSubmitting(false);
    }
  }

  async function postDismiss(reason: string | null) {
    const res = await fetch(
      `/api/production-items/${candidate.pillar.id}/spoke-dismiss`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetFormatId: candidate.format.id,
          ...(reason ? { reason } : {}),
        }),
      },
    );
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || `HTTP ${res.status}`);
    }
  }

  async function handleDismissOnly() {
    if (busy) return;
    setDismissing(true);
    try {
      await postDismiss(null);
      toast(`Dismissed — ${candidate.format.name}`, {
        description: "Won't reappear for 30 days.",
        duration: 4000,
      });
      onOpenChange(false);
      onActioned();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to dismiss");
    } finally {
      setDismissing(false);
    }
  }

  async function handleKill(reason: string) {
    setDismissing(true);
    try {
      await postDismiss(reason);
      toast(`Killed — ${candidate.format.name}`, {
        description: "Won't reappear for 30 days.",
        duration: 4000,
      });
      setKillOpen(false);
      onOpenChange(false);
      onActioned();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to kill");
    } finally {
      setDismissing(false);
    }
  }

  const b = candidate.breakdown;
  const shippedPriors = candidate.priorAttempts.filter(
    (p) => p.status === "Published",
  );
  const killedPriors = candidate.priorAttempts.filter(
    (p) => p.status === "Killed",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto gap-5">
        <DialogHeader className="sr-only">
          <DialogTitle>
            {candidate.pillar.title || "Repurpose"} →{" "}
            {candidate.format.name}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-900 border border-emerald-200"
                title="SPOKE algorithm score — pillar × format × freshness × pair history"
              >
                SPOKE {candidate.spokeScore.toFixed(1)}×
              </span>
              <AccountBadge
                account={candidate.pillar.account}
                postType="youtube_long"
                variant="compact"
              />
            </div>
            <h2 className="text-lg font-semibold pr-8">
              {candidate.pillar.title || "(Untitled)"}{" "}
              <span className="text-muted-foreground font-normal">
                → {candidate.format.name}
              </span>
            </h2>
          </div>

          <section className="rounded-md border border-border bg-emerald-50/40 p-3 space-y-2">
            <div className="flex items-baseline justify-between flex-wrap gap-x-4 gap-y-1">
              <div className="text-sm text-foreground">
                <span className="font-semibold tabular-nums">
                  {formatCompact(candidate.pillar.views)}
                </span>{" "}
                pillar views ·{" "}
                <span className="font-medium text-foreground">
                  {candidate.format.name}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {candidate.spokeScore.toFixed(2)}× SPOKE
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              <span className="font-semibold text-foreground">
                Why this pair:
              </span>{" "}
              {candidate.whySpoke}
            </p>
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                Signal breakdown
              </summary>
              <ul className="mt-1 space-y-0.5 pl-3 tabular-nums">
                <li>
                  <span className="font-medium text-foreground">
                    Pillar strength:
                  </span>{" "}
                  {b.pillarStrength.toFixed(2)}× ({formatCompact(
                    candidate.pillar.views,
                  )}{" "}
                  vs channel P60 {formatCompact(b.pillarChannelP60)}, cohort{" "}
                  {b.pillarChannelCohortSize})
                </li>
                <li>
                  <span className="font-medium text-foreground">Format fit:</span>{" "}
                  {b.formatFit.toFixed(2)}× (format P60 {formatCompact(
                    b.formatBrandP60,
                  )}{" "}
                  vs brand P60 {formatCompact(b.brandAllFormatsP60)})
                  {b.pairSourceCohortSize > 0 && (
                    <>
                      {" "}
                      · pair lift{" "}
                      {(
                        b.pairSourceP50 / Math.max(1, b.formatBrandP60)
                      ).toFixed(2)}
                      × from {b.pairSourceCohortSize} prior off this channel
                    </>
                  )}
                </li>
                <li>
                  <span className="font-medium text-foreground">Freshness:</span>{" "}
                  {b.freshnessFactor.toFixed(2)}× (pillar is{" "}
                  {Math.round(b.ageDays)}d old)
                </li>
                <li>
                  <span className="font-medium text-foreground">
                    Pair history:
                  </span>{" "}
                  {b.pairHistoryMultiplier.toFixed(2)}×{" "}
                  {candidate.priorAttempts.length === 0
                    ? "(no prior attempts)"
                    : `(${candidate.priorAttempts.length} prior)`}
                </li>
              </ul>
            </details>
          </section>

          {shippedPriors.length > 0 && (
            <section className="rounded-md border border-border bg-muted/30 p-3 text-xs space-y-1">
              <div className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Prior shipped derivatives ({shippedPriors.length})
              </div>
              {shippedPriors.slice(0, 4).map((p) => (
                <div key={p.productionItemId} className="text-muted-foreground">
                  <Link
                    href={`/${brand}/content/${p.productionItemId}`}
                    target="_blank"
                    className="hover:underline"
                  >
                    Published
                  </Link>
                  {p.publishedAt && (
                    <span>
                      {" "}
                      · {new Date(p.publishedAt).toLocaleDateString()}
                    </span>
                  )}
                  {p.views != null && (
                    <span> · {formatCompact(p.views)} views</span>
                  )}
                </div>
              ))}
            </section>
          )}

          {killedPriors.length > 0 && (
            <section className="rounded-md border border-amber-200 bg-amber-50/40 p-3 text-xs space-y-1">
              <div className="font-mono uppercase tracking-wider text-[10px] text-amber-800">
                Previously killed ({killedPriors.length})
              </div>
              <p className="text-muted-foreground">
                Pair was killed before — SPOKE dampens the score for 60 days
                after a kill. Worth a second look only if context has changed.
              </p>
            </section>
          )}

          <section className="space-y-2">
            <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              Assign editor
            </div>
            <UserCombobox
              value={assigneeUserId || ""}
              onValueChange={(v) => setAssigneeUserId(v)}
              users={assignableUsers}
              disabled={busy}
              triggerClassName="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:border-ring"
              placeholder="Select an editor…"
            />
          </section>

          <button
            type="button"
            onClick={() => void handleRepurpose()}
            disabled={busy || !assigneeUserId}
            className={cn(
              "h-10 w-full rounded-md text-sm font-medium transition-colors",
              "bg-emerald-600 text-white hover:bg-emerald-700",
              "disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed",
            )}
            title={
              !assigneeUserId
                ? "Pick an editor first"
                : `Create a ${candidate.format.name} draft in Assigned`
            }
          >
            {submitting
              ? "Queueing repurpose…"
              : !assigneeUserId
                ? "Pick an editor to continue"
                : `Repurpose into ${candidate.format.name}`}
          </button>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <div className="flex items-center gap-3">
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
            </div>
            <div className="flex items-center gap-3">
              {candidate.pillar.publishedLink && (
                <a
                  href={candidate.pillar.publishedLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  See pillar
                  <ExternalLinkIcon className="size-3" />
                </a>
              )}
              <Link
                href={`/${brand}/content/${candidate.pillar.id}`}
                target="_blank"
                className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                Open pillar page
                <ExternalLinkIcon className="size-3" />
              </Link>
            </div>
          </div>
        </div>

        <KillIdeaDialog
          open={killOpen}
          onOpenChange={setKillOpen}
          title={`${candidate.pillar.title || "(Untitled)"} → ${candidate.format.name}`}
          saving={dismissing}
          onConfirm={handleKill}
        />
      </DialogContent>
    </Dialog>
  );
}
