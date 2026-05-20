"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccountBadge } from "@/components/ui/account-badge";
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

  async function handleRepurpose() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/production-items/${candidate.pillar.id}/repurpose`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetFormatId: candidate.format.id }),
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
        description: "Lands in Assigned for you to draft.",
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

          <button
            type="button"
            onClick={() => void handleRepurpose()}
            disabled={submitting}
            className={cn(
              "h-10 w-full rounded-md text-sm font-medium transition-colors",
              "bg-emerald-600 text-white hover:bg-emerald-700",
              "disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed",
            )}
          >
            {submitting
              ? "Queueing repurpose…"
              : `Repurpose into ${candidate.format.name}`}
          </button>

          <div className="flex items-center justify-end border-t border-border pt-3">
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
      </DialogContent>
    </Dialog>
  );
}
