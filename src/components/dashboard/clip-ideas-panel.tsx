"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDownIcon,
  SparklesIcon,
  RefreshCwIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ClipTriageDialog } from "./clip-triage-dialog";

interface ClipIdea {
  id: string;
  batchId: string;
  startSec: number;
  endSec: number;
  hook: string;
  angle: string;
  rationale: string;
  blueprintAnchorHook: string | null;
  transcriptAnchorQuote: string | null;
  transcriptAnchorStartSec: number | null;
  algorithmLabel: string | null;
  confidence: number | null;
  estimatedViews: number | null;
  status: string;
  acceptedNotionPageUrl: string | null;
  acceptedTargetFormat: string | null;
  acceptedEditorUserId: string | null;
  acceptedEditorName: string | null;
  acceptedEditorEmail: string | null;
  acceptedProductionItemId: string | null;
  transcriptExcerpt: string | null;
  createdAt: string;
}

interface PromotionFormat {
  id: string;
  name: string;
  brand: string;
  pack: { id: string; name: string } | null;
}

interface Props {
  itemId: string;
  brand: string;
  /** Generation calls Sonnet and costs money, so it stays admin-only — but
   *  viewing/triaging existing ideas is open to all signed-in users. When
   *  false, hide the Generate button and adjust the empty-state copy so
   *  non-admins don't get a "Forbidden" error from clicking it. */
  isAdmin: boolean;
}

function fmtTs(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function fmtDur(start: number, end: number): string {
  const d = Math.max(0, Math.round(end - start));
  return `${d}s`;
}

function fmtRel(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString();
}

export function ClipIdeasPanel({
  itemId,
  brand,
  isAdmin,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [ideas, setIdeas] = useState<ClipIdea[]>([]);
  const [batchCreatedAt, setBatchCreatedAt] = useState<string | null>(null);
  const [promotionFormat, setPromotionFormat] = useState<PromotionFormat | null>(
    null,
  );
  const [genState, setGenState] = useState<
    | { kind: "idle" }
    | { kind: "generating" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [triageIdea, setTriageIdea] = useState<ClipIdea | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/production-items/${itemId}/clip-ideas`);
      if (res.ok) {
        const json = (await res.json()) as {
          batch: { id: string; createdAt: string } | null;
          ideas: ClipIdea[];
          promotionFormat: PromotionFormat | null;
        };
        setIdeas(json.ideas);
        setBatchCreatedAt(json.batch?.createdAt ?? null);
        setPromotionFormat(json.promotionFormat ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleGenerate = useCallback(async (
    opts: { forceSections?: boolean } = {},
  ) => {
    setGenState({ kind: "generating" });
    const priorBatchCreatedAt = batchCreatedAt;
    try {
      const res = await fetch(
        `/api/production-items/${itemId}/clip-ideas/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forceSections: opts.forceSections === true }),
        }
      );
      // Tolerate non-JSON bodies — Heroku's 502 error page is HTML, for
      // example, and res.json() would throw "Unexpected token '<'".
      const bodyText = await res.text();
      let json: { error?: string } | null = null;
      try {
        json = bodyText ? (JSON.parse(bodyText) as { error?: string }) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        setGenState({
          kind: "error",
          message: json?.error || `Generation failed (${res.status})`,
        });
        return;
      }

      // 202 Accepted: agent is running in the background to dodge Heroku's
      // 30s router timeout. Poll GET /clip-ideas until a fresh batch appears
      // (detected by a changed createdAt) or 3 minutes elapse.
      const DEADLINE_MS = 3 * 60 * 1000;
      const POLL_MS = 5000;
      const started = Date.now();
      while (Date.now() - started < DEADLINE_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const pollRes = await fetch(
          `/api/production-items/${itemId}/clip-ideas`
        );
        if (!pollRes.ok) continue;
        const pollJson = (await pollRes.json()) as {
          batch: { id: string; createdAt: string } | null;
          ideas: ClipIdea[];
        };
        if (
          pollJson.batch &&
          pollJson.batch.createdAt !== priorBatchCreatedAt
        ) {
          setIdeas(pollJson.ideas);
          setBatchCreatedAt(pollJson.batch.createdAt);
          setGenState({ kind: "idle" });
          return;
        }
      }
      setGenState({
        kind: "error",
        message:
          "Generation timed out after 3 minutes. Reload this page shortly to check — the agent may still finish.",
      });
    } catch (err) {
      setGenState({
        kind: "error",
        message: err instanceof Error ? err.message : "Generation failed",
      });
    }
  }, [itemId, batchCreatedAt]);

  return (
    <div className="rounded-lg border border-border bg-card p-4 sm:p-5 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
            Clip Ideas
          </h3>
          {ideas[0]?.algorithmLabel && (
            <span
              className="inline-flex items-center rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
              title="The clip-idea algorithm version that generated this batch"
            >
              {ideas[0].algorithmLabel}
            </span>
          )}
          {batchCreatedAt && (
            <span className="text-[11px] text-muted-foreground">
              batch generated {fmtRel(batchCreatedAt)}
            </span>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleGenerate({ forceSections: false })}
              disabled={genState.kind === "generating"}
              className="h-7 text-xs gap-1.5 rounded-r-none border-r-0"
              title={
                ideas.length > 0
                  ? "Re-run only the per-format hook writer — reuses the existing detected sections."
                  : "Run the two-pass agent (detect sections + write hooks) against this transcript."
              }
            >
              {genState.kind === "generating" ? (
                <RefreshCwIcon className="size-3.5 animate-spin" />
              ) : (
                <SparklesIcon className="size-3.5" />
              )}
              {genState.kind === "generating"
                ? "Generating…"
                : ideas.length > 0
                  ? "Regenerate hooks"
                  : "Generate clip ideas"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={genState.kind === "generating"}
                className="h-7 w-7 p-0 rounded-r-md rounded-l-none border border-l-0 border-input bg-background hover:bg-accent inline-flex items-center justify-center disabled:opacity-50"
                aria-label="More generation options"
              >
                <ChevronDownIcon className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuItem
                  onClick={() => void handleGenerate({ forceSections: false })}
                  className="flex flex-col items-start gap-0.5 py-2"
                >
                  <span className="font-medium text-xs">
                    Regenerate hooks only
                  </span>
                  <span className="text-[11px] text-muted-foreground leading-snug">
                    Reuse the detected sections. Re-runs the per-format hook
                    writer (Haiku) across every clippable format on this brand.
                    Cheap, ~$0.04/format.
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void handleGenerate({ forceSections: true })}
                  className="flex flex-col items-start gap-0.5 py-2"
                >
                  <span className="font-medium text-xs">
                    Regenerate sections + hooks (full)
                  </span>
                  <span className="text-[11px] text-muted-foreground leading-snug">
                    Re-detect sections (Sonnet, ~$0.10) then re-write hooks for
                    every format. Kills the prior section batch + its derived
                    ideas across every format.
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {genState.kind === "error" && (
        <p className="text-xs text-red-600">{genState.message}</p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : ideas.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {isAdmin
            ? "No ideas yet. Click Generate 10 ideas to have the agent read the transcript and propose short-form clip candidates."
            : "No clip ideas yet."}
        </p>
      ) : (
        <ol className="space-y-2">
          {ideas.map((idea, i) => {
            const accepted = idea.status === "accepted";
            const assigned = idea.status === "assigned";
            const killed = idea.status === "killed";
            const canOpen = !accepted;
            return (
              <li
                key={idea.id}
                className={cn(
                  "rounded-md border border-border bg-background p-3 space-y-1.5 transition-colors",
                  canOpen && "cursor-pointer hover:border-foreground/30",
                  assigned && "border-blue-200 bg-blue-50/40",
                  killed && "opacity-50"
                )}
                onClick={() => {
                  if (canOpen) setTriageIdea(idea);
                }}
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-xs font-mono text-muted-foreground shrink-0">
                    #{i + 1}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono",
                      "bg-muted text-muted-foreground"
                    )}
                    title={`Clip runs ${fmtDur(idea.startSec, idea.endSec)}`}
                  >
                    {fmtTs(idea.startSec)}–{fmtTs(idea.endSec)}{" "}
                    <span className="opacity-70">
                      ({fmtDur(idea.startSec, idea.endSec)})
                    </span>
                  </span>
                  {accepted && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                      Accepted
                      {idea.acceptedTargetFormat && (
                        <span className="text-muted-foreground">
                          → {idea.acceptedTargetFormat}
                        </span>
                      )}
                    </span>
                  )}
                  {assigned && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700">
                      {idea.acceptedProductionItemId ? (
                        <Link
                          href={`/${brand}/content/${idea.acceptedProductionItemId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 hover:underline"
                          title="Open the assigned content"
                        >
                          Assigned
                          <ExternalLinkIcon className="size-3" />
                        </Link>
                      ) : (
                        <span>Assigned</span>
                      )}
                      {idea.acceptedEditorName && (
                        <>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-muted-foreground">
                            {idea.acceptedEditorName}
                          </span>
                        </>
                      )}
                    </span>
                  )}
                  {killed && (
                    <span className="text-[11px] font-medium text-muted-foreground">
                      Killed
                    </span>
                  )}
                  {accepted && idea.acceptedNotionPageUrl && (
                    <a
                      href={idea.acceptedNotionPageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                      title="Open the Notion A-Record"
                    >
                      <ExternalLinkIcon className="size-3" /> Notion
                    </a>
                  )}
                </div>
                <div className="space-y-0.5">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Hook
                  </h4>
                  <p className="text-sm font-medium text-foreground leading-snug">
                    {idea.hook}
                  </p>
                </div>
                <div className="space-y-0.5">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Why it&apos;ll go viral
                  </h4>
                  <p className="text-[13px] text-foreground/90 leading-relaxed">
                    {idea.rationale}
                  </p>
                </div>
                {idea.blueprintAnchorHook && (
                  <div className="space-y-0.5">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Mirroring viral hook
                    </h4>
                    <p className="text-[12px] text-foreground/80 leading-relaxed italic">
                      &ldquo;{idea.blueprintAnchorHook}&rdquo;
                    </p>
                  </div>
                )}
                {idea.transcriptAnchorQuote && (
                  <div className="space-y-0.5">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Anchor line
                      {idea.transcriptAnchorStartSec != null && (
                        <span className="ml-1.5 font-mono normal-case tracking-normal text-muted-foreground/70">
                          @ {fmtTs(idea.transcriptAnchorStartSec)}
                        </span>
                      )}
                    </h4>
                    <p className="text-[12px] text-foreground/80 leading-relaxed italic">
                      &ldquo;{idea.transcriptAnchorQuote}&rdquo;
                    </p>
                  </div>
                )}
                {idea.transcriptExcerpt && (
                  <div className="space-y-0.5">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Transcript
                    </h4>
                    <p className="text-[12px] text-muted-foreground leading-relaxed line-clamp-3">
                      {idea.transcriptExcerpt}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <ClipTriageDialog
        open={triageIdea !== null}
        onOpenChange={(o) => {
          if (!o) setTriageIdea(null);
        }}
        idea={triageIdea}
        onDone={load}
        brand={brand}
        promotionFormat={promotionFormat}
      />
    </div>
  );
}
