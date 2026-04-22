"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
  acceptedEditorUserId: string | null;
  acceptedEditorName: string | null;
  acceptedEditorEmail: string | null;
  acceptedProductionItemId: string | null;
  transcriptExcerpt: string | null;
  createdAt: string;
}

interface Props {
  itemId: string;
  brand: string;
  hasDescriptProject: boolean;
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
  hasDescriptProject,
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
    const priorBatchCreatedAt = batchCreatedAt;
    try {
      const res = await fetch(
        `/api/production-items/${itemId}/clip-ideas/generate`,
        { method: "POST" }
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
      />
    </div>
  );
}
