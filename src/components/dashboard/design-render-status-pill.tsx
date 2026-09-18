"use client";

/** Content-detail chip for posts exported from the in-app design editor.
 *  Renders nothing for items the editor never touched. Same contract as
 *  ClipRenderStatusPill. */
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { DesignRenderStatus } from "@/lib/services/design-editor/render-status";

const DesignEditorDialog = dynamic(
  () => import("@/components/design-editor/design-editor-dialog").then((m) => m.DesignEditorDialog),
  { ssr: false },
);

const STYLE: Record<DesignRenderStatus["state"], { dot: string; label: (r: DesignRenderStatus) => string; detail: string }> = {
  queued: { dot: "bg-amber-500 animate-pulse", label: () => "Post queued…", detail: "Waiting for the render worker." },
  rendering: { dot: "bg-amber-500 animate-pulse", label: (r) => `Rendering post… ${r.progress}%`, detail: "Rendering the slides. They appear here when done." },
  done: { dot: "bg-emerald-500", label: (r) => `${r.pageCount ?? ""}-slide post rendered`, detail: "Designed in the in-app design editor." },
  failed: { dot: "bg-red-500", label: () => "Post render failed", detail: "The render failed. Retry, or reopen the design." },
  stalled: { dot: "bg-red-500", label: () => "Post render stalled", detail: "The render stopped reporting progress. Retry to queue a fresh one." },
  superseded: { dot: "bg-zinc-400", label: () => "Post render replaced", detail: "A newer export replaced this render." },
};

export function DesignRenderStatusPill({ productionItemId, brand, onRendered }: { productionItemId: string; brand: string; onRendered?: () => void }) {
  const [data, setData] = useState<{ render: DesignRenderStatus | null; canEdit?: boolean } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const lastState = useRef<string | null>(null);
  const onRenderedRef = useRef(onRendered);
  useEffect(() => {
    onRenderedRef.current = onRendered;
  }, [onRendered]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/production-items/${productionItemId}/design-render-status`);
      if (!res.ok) return;
      const json = (await res.json()) as { render: DesignRenderStatus | null; canEdit?: boolean };
      const next = json.render?.state ?? null;
      if (lastState.current && lastState.current !== "done" && next === "done") onRenderedRef.current?.();
      lastState.current = next;
      setData(json);
    } catch {
      // best-effort
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

  const retry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/production-items/${productionItemId}/design/export`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error("Couldn't restart the render", { description: json?.error ?? `HTTP ${res.status}` });
      toast.success("Rendering again…");
      await fetchStatus();
    } finally {
      setRetrying(false);
    }
  };

  const render = data?.render;
  if (!render) return null;
  const style = STYLE[render.state];
  const canAct = !!data?.canEdit;
  return (
    <>
      <Popover>
        <PopoverTrigger className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40">
          <span className={cn("size-1.5 rounded-full", style.dot)} aria-hidden />
          {style.label(render)}
        </PopoverTrigger>
        <PopoverContent className="w-[24rem] space-y-3" align="end">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Design editor</p>
            <p className="mt-1 text-sm font-medium text-foreground">{style.label(render)}</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">{style.detail}</p>
            {render.error && (render.state === "failed" || render.state === "stalled") && (
              <p className="mt-2 break-words rounded bg-red-50 p-2 font-mono text-[11px] leading-snug text-red-800">{render.error}</p>
            )}
          </div>
          {canAct && (
            <div className="flex items-center gap-2 border-t border-border pt-3">
              {(render.state === "failed" || render.state === "stalled") && (
                <Button size="sm" onClick={() => void retry()} disabled={retrying}>{retrying ? "Retrying…" : "Retry render"}</Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditorOpen(true)}>Edit design & re-export</Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {canAct && editorOpen && (
        <DesignEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          productionItemId={productionItemId}
          brand={brand}
          onDone={() => void fetchStatus()}
          onUnsupported={(m) => { setEditorOpen(false); toast.error(m ?? "This post can't be opened in the design editor"); }}
        />
      )}
    </>
  );
}
