"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SparklesIcon, RefreshCwIcon, ExternalLinkIcon } from "lucide-react";
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
  confidence: number | null;
  estimatedViews: number | null;
  status: string;
  acceptedNotionPageUrl: string | null;
  acceptedTargetFormat: string | null;
  createdAt: string;
}

interface Props {
  itemId: string;
  hasDescriptProject: boolean;
  pillarFormat: string | null;
  brand: string;
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

function fmtViews(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K views`;
  return `${n.toLocaleString()} views`;
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
  hasDescriptProject,
  pillarFormat,
  brand,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [ideas, setIdeas] = useState<ClipIdea[]>([]);
  const [batchCreatedAt, setBatchCreatedAt] = useState<string | null>(null);
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
        };
        setIdeas(json.ideas);
        setBatchCreatedAt(json.batch?.createdAt ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleGenerate = useCallback(async () => {
    setGenState({ kind: "generating" });
    try {
      const res = await fetch(
        `/api/production-items/${itemId}/clip-ideas/generate`,
        { method: "POST" }
      );
      const json = await res.json();
      if (!res.ok) {
        setGenState({
          kind: "error",
          message: json?.error || `Generation failed (${res.status})`,
        });
        return;
      }
      setGenState({ kind: "idle" });
      await load();
    } catch (err) {
      setGenState({
        kind: "error",
        message: err instanceof Error ? err.message : "Generation failed",
      });
    }
  }, [itemId, load]);

  if (!hasDescriptProject) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-4 sm:p-5 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-baseline gap-3">
          <h3 className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
            Clip Ideas
          </h3>
          {batchCreatedAt && (
            <span className="text-[11px] text-muted-foreground">
              batch generated {fmtRel(batchCreatedAt)}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={genState.kind === "generating"}
          className="h-7 text-xs gap-1.5"
          title={
            ideas.length > 0
              ? "Re-run the agent against this transcript — replaces the panel with a fresh batch"
              : "Run the agent against this transcript and propose 10 clip ideas"
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
              ? "Regenerate"
              : "Generate 10 ideas"}
        </Button>
      </div>

      {genState.kind === "error" && (
        <p className="text-xs text-red-600">{genState.message}</p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : ideas.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No ideas yet. Click Generate 10 ideas to have the agent read the
          transcript and propose short-form clip candidates.
        </p>
      ) : (
        <ol className="space-y-2">
          {ideas.map((idea, i) => {
            const accepted = idea.status === "accepted";
            const killed = idea.status === "killed";
            const interactive = idea.status === "suggested";
            return (
              <li
                key={idea.id}
                className={cn(
                  "rounded-md border border-border bg-background p-3 space-y-1.5 transition-colors",
                  interactive && "cursor-pointer hover:border-foreground/30",
                  killed && "opacity-50"
                )}
                onClick={() => {
                  if (interactive) setTriageIdea(idea);
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
                  {idea.estimatedViews != null ? (
                    <span
                      className="text-[11px] font-medium text-foreground"
                      title="Model's estimate of realistic view count on best-fit short-form channel, calibrated against brand historicals"
                    >
                      ~{fmtViews(idea.estimatedViews)}
                    </span>
                  ) : idea.confidence != null ? (
                    <span
                      className="text-[11px] text-muted-foreground"
                      title="Legacy confidence score (pre-v2 batch)"
                    >
                      {Math.round(idea.confidence * 100)}%
                    </span>
                  ) : null}
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
                <p className="text-sm font-medium text-foreground leading-snug">
                  “{idea.hook}”
                </p>
                <p className="text-[13px] text-foreground leading-snug">
                  <span className="text-muted-foreground">Angle: </span>
                  {idea.angle}
                </p>
                <p className="text-[12px] text-muted-foreground leading-snug">
                  <span className="font-medium text-foreground/80">Why: </span>
                  {idea.rationale}
                </p>
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
        pillarFormat={pillarFormat}
        brand={brand}
        onDone={load}
      />
    </div>
  );
}
