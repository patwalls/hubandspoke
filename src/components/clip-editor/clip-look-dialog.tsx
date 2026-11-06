"use client";

/**
 * The format page's clip LOOK editor — the template counterpart of the clip
 * editor, the way the design editor has a template mode. No clip: the stage
 * shows a placeholder where the video sits, a placeholder hook and sample
 * captions (look-preview.ts), and every change autosaves the style half of
 * the doc (`lookFromDoc`) to `formats.clip_template`. Real clips keep their
 * own AI hook text; only style and position come from here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckIcon, Loader2Icon, Redo2Icon, Undo2Icon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { lookFromDoc, type AspectRatio, type ClipLook } from "@/lib/clip-editor/doc";
import { SAMPLE_WORDS, buildLookPreviewDoc } from "@/lib/clip-editor/look-preview";
import { compileRenderPlan } from "@/lib/clip-editor/plan";
import { resolveScene } from "@/lib/clip-editor/scene";
import { Inspector } from "./inspector";
import { PlaybackEngine } from "./playback-engine";
import { Stage } from "./stage";
import { EditorStoreContext, createEditorStore, useEditor, useEditorStoreApi } from "./store";
import { framingFor } from "./framing";
import { useCanEditBrand } from "@/components/brand-access";

const AUTOSAVE_DELAY_MS = 900;

/** `intro`: a note under the header — the Add format flow's "last step"
 *  explanation. */
export function ClipLookDialog({ open, onOpenChange, formatId, formatName, brand, look, aspectRatio, onSaved, intro }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  formatId: string;
  formatName: string;
  brand: string;
  /** The format's current look; null = start from the default layout. */
  look: ClipLook | null;
  aspectRatio: AspectRatio;
  onSaved: () => void;
  intro?: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1200px,97vw)]">
        {open && <LookHost formatId={formatId} formatName={formatName} brand={brand} look={look} aspectRatio={aspectRatio} onSaved={onSaved} onClose={() => onOpenChange(false)} intro={intro ?? null} />}
      </DialogContent>
    </Dialog>
  );
}

/** Owns the shape: switching Vertical / Horizontal saves the look, writes
 *  the format's `clip_aspect_ratio` (which every new clip edit of the
 *  format reads — session.ts → resolveClipAspectRatio), reloads the look and
 *  remounts the editor on the new frame. */
function LookHost(props: { formatId: string; formatName: string; brand: string; look: ClipLook | null; aspectRatio: AspectRatio; onSaved: () => void; onClose: () => void; intro: string | null }) {
  const [current, setCurrent] = useState({ look: props.look, aspectRatio: props.aspectRatio, epoch: 0 });
  const changeAspect = useCallback(
    async (next: AspectRatio, flush: () => Promise<boolean>) => {
      if (next === current.aspectRatio) return;
      if (!(await flush())) return void toast.error("Couldn't save the look — try again");
      const res = await fetch("/api/formats", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: props.formatId, clipAspectRatio: next }),
      }).catch(() => null);
      if (!res?.ok) return void toast.error("Couldn't change the shape — try again");
      const tpl = await fetch(`/api/formats/${props.formatId}/clip-template`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      setCurrent((c) => ({ look: tpl?.look ?? c.look, aspectRatio: (tpl?.aspectRatio as AspectRatio | undefined) ?? next, epoch: c.epoch + 1 }));
      props.onSaved();
    },
    [current.aspectRatio, props],
  );
  return (
    <LookEditor
      key={current.epoch}
      {...props}
      look={current.look}
      aspectRatio={current.aspectRatio}
      onChangeAspect={changeAspect}
    />
  );
}

function LookEditor(props: { formatId: string; formatName: string; brand: string; look: ClipLook | null; aspectRatio: AspectRatio; onSaved: () => void; onClose: () => void; intro: string | null; onChangeAspect: (next: AspectRatio, flush: () => Promise<boolean>) => Promise<void> }) {
  const [store] = useState(() => createEditorStore({ doc: buildLookPreviewDoc(props.look, props.aspectRatio), revision: 0 }));
  return (
    <EditorStoreContext.Provider value={store}>
      <LookWorkspace {...props} />
    </EditorStoreContext.Provider>
  );
}

function LookWorkspace({ formatId, formatName, brand, onSaved, onClose, intro, aspectRatio, onChangeAspect }: { formatId: string; formatName: string; brand: string; onSaved: () => void; onClose: () => void; intro: string | null; aspectRatio: AspectRatio; onChangeAspect: (next: AspectRatio, flush: () => Promise<boolean>) => Promise<void> }) {
  const storeApi = useEditorStoreApi();
  // View-only users can look at the format's clip look, not change it.
  const viewOnly = !useCanEditBrand(brand);
  const [reshaping, setReshaping] = useState(false);
  const doc = useEditor((s) => s.doc);
  const saveState = useEditor((s) => s.saveState);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const [engine] = useState(() => new PlaybackEngine());
  const plan = useMemo(() => compileRenderPlan(doc, SAMPLE_WORDS), [doc]);
  const scene = useMemo(() => resolveScene(plan), [plan]);

  // A second in, so the captions show a full cue rather than the first word.
  useEffect(() => {
    engine.setPlan(plan);
  }, [engine, plan]);
  useEffect(() => {
    engine.seek(1);
  }, [engine]);

  const saving = useRef<Promise<boolean>>(Promise.resolve(true));
  const save = useCallback((): Promise<boolean> => {
    saving.current = saving.current.then(async () => {
      const { doc: current, savedDoc, revision } = storeApi.getState();
      if (viewOnly || current === savedDoc) return true;
      storeApi.getState().markSaving();
      try {
        const res = await fetch(`/api/formats/${formatId}/clip-template`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ look: lookFromDoc(current) }) });
        if (!res.ok) return (storeApi.getState().markSaveFailed("error"), false);
        storeApi.getState().markSaved(current, revision + 1);
        onSaved();
        return true;
      } catch {
        storeApi.getState().markSaveFailed("error");
        return false;
      }
    });
    return saving.current;
  }, [formatId, onSaved, storeApi, viewOnly]);

  // Closing with Esc / a click outside unmounts us: flush whatever is unsaved.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(() => () => void saveRef.current(), []);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [doc, saveState, save]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const close = async () => {
    if (!(await save())) return void toast.error("Couldn't save the look — try again");
    onClose();
  };

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <DialogTitle className="text-sm font-semibold">Clip look</DialogTitle>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{formatName}</span>
        <div className="ml-2 flex items-center gap-0.5 rounded-md bg-muted p-0.5" role="group" aria-label="Video shape" data-testid="clip-look-shape">
          {(["9:16", "16:9"] as const).map((a) => (
            <button
              key={a}
              type="button"
              disabled={viewOnly || reshaping}
              aria-pressed={aspectRatio === a}
              onClick={async () => {
                setReshaping(true);
                try {
                  await onChangeAspect(a, save);
                } finally {
                  setReshaping(false);
                }
              }}
              className={
                "rounded px-2 py-0.5 text-[11px] transition-colors " +
                (aspectRatio === a ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:text-foreground")
              }
              data-testid={`clip-look-shape-${a === "9:16" ? "vertical" : "horizontal"}`}
            >
              {a === "9:16" ? "Vertical 9:16" : "Horizontal 16:9"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {saveState === "saving" ? <><Loader2Icon className="size-3 animate-spin" /> Saving…</> : saveState === "error" ? <span className="text-destructive">Not saved</span> : saveState === "dirty" ? "Unsaved" : <><CheckIcon className="size-3" /> Saved</>}
          </span>
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={!canUndo || viewOnly} onClick={undo} title="Undo (⌘Z)"><Undo2Icon className="size-3.5" /></Button>
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={!canRedo || viewOnly} onClick={redo} title="Redo (⇧⌘Z)"><Redo2Icon className="size-3.5" /></Button>
        </div>
      </header>
      {intro && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900" data-testid="clip-look-intro">
          {intro}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] gap-4 p-4">
        <div className="relative min-h-0 min-w-0">
          <Stage plan={plan} scene={scene} engine={engine} videoUrl={null} brand={brand} readOnly={viewOnly} />
        </div>
        <Inspector doc={doc} framing={framingFor(doc, null, null)} disabled={viewOnly} brand={brand} />
      </div>
      <footer className="flex items-center gap-3 border-t border-border px-4 py-2.5">
        <p className="text-[11px] text-muted-foreground">Style the hook, captions, video placement and layers. Every new clip of this format starts from this look — with its own AI-written hook; the text here is a placeholder.</p>
        <Button type="button" size="sm" className="ml-auto h-8" onClick={() => void close()}>{viewOnly ? "Close" : <>Save look &amp; close</>}</Button>
      </footer>
    </>
  );
}
