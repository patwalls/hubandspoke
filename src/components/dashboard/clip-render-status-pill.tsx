"use client";

/**
 * Status chip for clips exported from the in-app clip editor — the
 * counterpart of DescriptStatusPill for items whose video we render
 * ourselves. Renders NOTHING for items the editor never touched, so mounting
 * it on every content page is free for the rest of the app.
 *
 * Everyone on the team sees the state (rendering / ready / failed). Only
 * users with the `clipEditor` flag (`canEdit` from the API) get the actions:
 * retry a failed render, or reopen the editor and re-export.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ClipRenderStatus } from "@/lib/services/clip-editor/render-status";

const ClipEditorDialog = dynamic(
  () =>
    import("@/components/clip-editor/clip-editor-dialog").then(
      (m) => m.ClipEditorDialog,
    ),
  { ssr: false },
);

interface StatusResponse {
  render: ClipRenderStatus | null;
  clipIdeaId?: string | null;
  canEdit?: boolean;
}

const STATE_STYLE: Record<
  ClipRenderStatus["state"],
  { dot: string; label: (r: ClipRenderStatus) => string; detail: string }
> = {
  queued: {
    dot: "bg-amber-500 animate-pulse",
    label: () => "Clip queued…",
    detail: "Waiting for the render worker to pick it up.",
  },
  rendering: {
    dot: "bg-amber-500 animate-pulse",
    label: (r) => `Rendering clip… ${r.progress}%`,
    detail: "Rendering on our servers. The video appears here when it's done.",
  },
  done: {
    dot: "bg-emerald-500",
    label: () => "Clip rendered",
    detail: "Rendered by the in-app clip editor.",
  },
  failed: {
    dot: "bg-red-500",
    label: () => "Clip render failed",
    detail: "The render failed. The worker retries automatically a couple of times; you can also retry now.",
  },
  stalled: {
    dot: "bg-red-500",
    label: () => "Clip render stalled",
    detail: "The render stopped reporting progress — the worker probably restarted mid-render. Retry to queue a fresh one.",
  },
  superseded: {
    dot: "bg-zinc-400",
    label: () => "Clip render replaced",
    detail: "A newer export replaced this render.",
  },
};

export function ClipRenderStatusPill({
  productionItemId,
  brand,
  onRendered,
}: {
  productionItemId: string;
  brand: string;
  /** Called once when a render finishes, so the page can pull the new media. */
  onRendered?: () => void;
}) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const lastState = useRef<string | null>(null);
  const onRenderedRef = useRef(onRendered);
  useEffect(() => {
    onRenderedRef.current = onRendered;
  }, [onRendered]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/production-items/${productionItemId}/clip-render-status`);
      if (!res.ok) return;
      const json = (await res.json()) as StatusResponse;
      const next = json.render?.state ?? null;
      if (lastState.current && lastState.current !== "done" && next === "done") {
        onRenderedRef.current?.();
      }
      lastState.current = next;
      setData(json);
    } catch {
      // Best-effort — a transient failure just leaves the last known state.
    }
  }, [productionItemId]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const inFlight = data?.render?.state === "queued" || data?.render?.state === "rendering";
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => void fetchStatus(), 4000);
    return () => clearInterval(t);
  }, [inFlight, fetchStatus]);

  const retry = useCallback(async () => {
    if (!data?.clipIdeaId) return;
    setRetrying(true);
    try {
      const res = await fetch(`/api/clip-ideas/${data.clipIdeaId}/editor/export`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error("Couldn't restart the render", {
          description: json?.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast.success("Rendering again…");
      await fetchStatus();
    } finally {
      setRetrying(false);
    }
  }, [data?.clipIdeaId, fetchStatus]);

  const render = data?.render;
  if (!render) return null;
  const style = STATE_STYLE[render.state];
  const canAct = !!data?.canEdit && !!data?.clipIdeaId;

  return (
    <>
      <Popover>
        <PopoverTrigger className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40">
          <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden />
          {style.label(render)}
        </PopoverTrigger>
        <PopoverContent className="w-[24rem] space-y-3" align="end">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Clip editor
            </p>
            <p className="mt-1 text-sm font-medium text-foreground">{style.label(render)}</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">{style.detail}</p>
            {render.error && (render.state === "failed" || render.state === "stalled") && (
              <p className="mt-2 break-words rounded bg-red-50 p-2 font-mono text-[11px] leading-snug text-red-800">
                {render.error}
              </p>
            )}
            {render.state === "done" && render.durationSec != null && (
              <p className="mt-2 text-xs text-muted-foreground">
                {Math.round(render.durationSec)}s clip
                {render.renderSeconds != null && ` · rendered in ${Math.round(render.renderSeconds)}s`}
              </p>
            )}
          </div>
          {canAct && (
            <div className="flex items-center gap-2 border-t border-border pt-3">
              {(render.state === "failed" || render.state === "stalled") && (
                <Button size="sm" onClick={() => void retry()} disabled={retrying}>
                  {retrying ? "Retrying…" : "Retry render"}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditorOpen(true)}>
                Edit clip & re-export
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {canAct && editorOpen && (
        <ClipEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          clipIdeaId={data!.clipIdeaId!}
          brand={brand}
          onDone={() => void fetchStatus()}
          onUnsupported={() => {
            setEditorOpen(false);
            toast.error("This clip can't be opened in the editor");
          }}
        />
      )}
    </>
  );
}
