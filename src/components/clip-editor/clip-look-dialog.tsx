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

const AUTOSAVE_DELAY_MS = 900;

export function ClipLookDialog({ open, onOpenChange, formatId, formatName, brand, look, aspectRatio, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  formatId: string;
  formatName: string;
  brand: string;
  /** The format's current look; null = start from the default layout. */
  look: ClipLook | null;
  aspectRatio: AspectRatio;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1200px,97vw)]">
        {open && <LookEditor formatId={formatId} formatName={formatName} brand={brand} look={look} aspectRatio={aspectRatio} onSaved={onSaved} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function LookEditor(props: { formatId: string; formatName: string; brand: string; look: ClipLook | null; aspectRatio: AspectRatio; onSaved: () => void; onClose: () => void }) {
  const [store] = useState(() => createEditorStore({ doc: buildLookPreviewDoc(props.look, props.aspectRatio), revision: 0 }));
  return (
    <EditorStoreContext.Provider value={store}>
      <LookWorkspace {...props} />
    </EditorStoreContext.Provider>
  );
}

function LookWorkspace({ formatId, formatName, brand, onSaved, onClose }: { formatId: string; formatName: string; brand: string; onSaved: () => void; onClose: () => void }) {
  const storeApi = useEditorStoreApi();
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
      if (current === savedDoc) return true;
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
  }, [formatId, onSaved, storeApi]);

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
        <div className="ml-auto flex items-center gap-1.5">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            {saveState === "saving" ? <><Loader2Icon className="size-3 animate-spin" /> Saving…</> : saveState === "error" ? <span className="text-destructive">Not saved</span> : saveState === "dirty" ? "Unsaved" : <><CheckIcon className="size-3" /> Saved</>}
          </span>
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={!canUndo} onClick={undo} title="Undo (⌘Z)"><Undo2Icon className="size-3.5" /></Button>
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={!canRedo} onClick={redo} title="Redo (⇧⌘Z)"><Redo2Icon className="size-3.5" /></Button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] gap-4 p-4">
        <div className="relative min-h-0 min-w-0">
          <Stage plan={plan} scene={scene} engine={engine} videoUrl={null} brand={brand} />
        </div>
        <Inspector doc={doc} disabled={false} brand={brand} />
      </div>
      <footer className="flex items-center gap-3 border-t border-border px-4 py-2.5">
        <p className="text-[11px] text-muted-foreground">Style the hook, captions, video placement and layers. Every new clip of this format starts from this look — with its own AI-written hook; the text here is a placeholder.</p>
        <Button type="button" size="sm" className="ml-auto h-8" onClick={() => void close()}>Save look &amp; close</Button>
      </footer>
    </>
  );
}
