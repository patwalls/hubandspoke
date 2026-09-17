"use client";

/**
 * The clip editor — what the queue's clip modal becomes for users with the
 * `clipEditor` flag. Same entry point and the same props as the classic
 * ClipTriageDialog, so the queue doesn't know which one it mounted.
 *
 * Shape of the editor (see src/lib/clip-editor/doc.ts for the model):
 *   session (server) → store (doc + undo) → plan → scene
 *                                             ├─ Stage            (preview)
 *                                             ├─ TranscriptEditor (word edits)
 *                                             ├─ Transport        (scrub + trim)
 *                                             └─ Inspector        (layer props)
 * Everything below the store is a pure function of the doc, recomputed on
 * each edit. Export sends nothing but "export what you have saved" — the
 * server renders from its own copy of the doc, never from client state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  CheckIcon,
  Loader2Icon,
  Redo2Icon,
  SparklesIcon,
  TimerOffIcon,
  Undo2Icon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { KillIdeaDialog } from "@/components/dashboard/kill-idea-dialog";
import type { ClipEditDoc } from "@/lib/clip-editor/doc";
import { compileRenderPlan } from "@/lib/clip-editor/plan";
import { resolveScene } from "@/lib/clip-editor/scene";
import { buildTranscriptView } from "@/lib/clip-editor/transcript-view";
import { findSilences, rangeForWordRun } from "@/lib/clip-editor/words";
import type { ClipEditorSession } from "@/lib/services/clip-editor/session";
import { Inspector } from "./inspector";
import { PlaybackEngine } from "./playback-engine";
import { Stage } from "./stage";
import {
  EditorStoreContext,
  commands,
  createEditorStore,
  useEditor,
  useEditorStoreApi,
} from "./store";
import { TranscriptEditor } from "./transcript-editor";
import { Transport } from "./transport";

const AUTOSAVE_DELAY_MS = 900;

export interface ClipEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clipIdeaId: string | null;
  brand: string;
  onDone: () => void;
  /** The editor can't open this idea (no video, no transcript, decided
   *  elsewhere, or the request failed) — caller shows the classic dialog. */
  onUnsupported: () => void;
}

export function ClipEditorDialog({
  open,
  onOpenChange,
  clipIdeaId,
  brand,
  onDone,
  onUnsupported,
}: ClipEditorDialogProps) {
  const [session, setSession] = useState<ClipEditorSession | null>(null);

  useEffect(() => {
    if (!open || !clipIdeaId) {
      setSession(null);
      return;
    }
    let cancelled = false;
    setSession(null);
    void (async () => {
      try {
        const res = await fetch(`/api/clip-ideas/${clipIdeaId}/editor`);
        if (cancelled) return;
        if (!res.ok) return onUnsupported();
        setSession((await res.json()) as ClipEditorSession);
      } catch {
        if (!cancelled) onUnsupported();
      }
    })();
    return () => {
      cancelled = true;
    };
    // onUnsupported is a fresh closure each render; keying on it would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clipIdeaId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1560px,97vw)]">
        {session ? (
          <EditorRoot
            key={session.edit.id}
            session={session}
            brand={brand}
            onDone={onDone}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <DialogTitle className="sr-only">The Clip</DialogTitle>
            <Loader2Icon className="size-5 animate-spin" />
            <span className="text-sm">Opening the editor…</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditorRoot(props: {
  session: ClipEditorSession;
  brand: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const store = useMemo(
    () => createEditorStore({ doc: props.session.edit.doc, revision: props.session.edit.revision }),
    [props.session],
  );
  return (
    <EditorStoreContext.Provider value={store}>
      <EditorWorkspace {...props} />
    </EditorStoreContext.Provider>
  );
}

function fmtDuration(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function EditorWorkspace({
  session,
  brand,
  onDone,
  onClose,
}: {
  session: ClipEditorSession;
  brand: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const storeApi = useEditorStoreApi();
  const doc = useEditor((s) => s.doc);
  const saveState = useEditor((s) => s.saveState);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const apply = useEditor((s) => s.apply);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);

  const [engine] = useState(() => new PlaybackEngine());
  const [busy, setBusy] = useState<null | "fillers" | "export" | "kill">(null);
  const [killOpen, setKillOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const plan = useMemo(() => compileRenderPlan(doc, session.words), [doc, session.words]);
  const scene = useMemo(() => resolveScene(plan), [plan]);
  const view = useMemo(() => buildTranscriptView(doc, session.words), [doc, session.words]);
  const locked = saveState === "conflict";
  const isReExport = session.clipIdea.status !== "suggested";

  useEffect(() => {
    engine.setPlan(plan);
  }, [engine, plan]);

  // ── Saving ───────────────────────────────────────────────────────────────
  // One save in flight at a time; a save requested mid-flight runs after it.
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const save = useCallback((): Promise<boolean> => {
    saveChain.current = saveChain.current.then(async () => {
      const { doc: current, savedDoc, revision, saveState: state } = storeApi.getState();
      if (state === "conflict") return false;
      if (current === savedDoc) {
        // Nothing to send (e.g. an edit was undone before the autosave
        // fired) — but still settle the indicator.
        storeApi.getState().markSaved(current, revision);
        return true;
      }
      storeApi.getState().markSaving();
      try {
        const res = await fetch(`/api/clip-ideas/${session.clipIdea.id}/editor`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision, doc: current }),
        });
        if (res.status === 409) {
          storeApi.getState().markSaveFailed("conflict");
          return false;
        }
        if (!res.ok) {
          storeApi.getState().markSaveFailed("error");
          return false;
        }
        const json = (await res.json()) as { revision: number };
        storeApi.getState().markSaved(current, json.revision);
        return true;
      } catch {
        storeApi.getState().markSaveFailed("error");
        return false;
      }
    });
    return saveChain.current;
  }, [session.clipIdea.id, storeApi]);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [doc, saveState, save]);

  // Closing the dialog unmounts us — don't lose the last second of edits.
  useEffect(() => () => void save(), [save]);

  // ── Keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (typing) return; // leave native text undo alone
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (typing) return;
      if (e.code === "Space") {
        // Space is play/pause everywhere, as in any editor — even when a
        // button still has focus from the last click.
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        engine.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, undo, redo]);

  // ── Bulk clean-up ────────────────────────────────────────────────────────
  const fillerCount = doc.sections.reduce(
    (n, s) => n + s.removals.filter((r) => r.reason === "filler").length,
    0,
  );
  const silenceCount = doc.sections.reduce(
    (n, s) => n + s.removals.filter((r) => r.reason === "silence").length,
    0,
  );

  const removeFillers = async () => {
    setBusy("fillers");
    try {
      const res = await fetch(`/api/clip-ideas/${session.clipIdea.id}/editor/fillers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ranges: doc.sections.map((s) => ({ startSec: s.startSec, endSec: s.endSec })),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        fillerIndexes?: number[];
        error?: string;
      };
      if (!res.ok || !json.fillerIndexes) {
        toast.error(json.error ?? "Couldn't detect filler words");
        return;
      }
      const fillers = new Set(json.fillerIndexes);
      let found = 0;
      apply((d) => {
        let next: ClipEditDoc = d;
        const plain = view.words.map((w) => w.word);
        // Consecutive fillers become ONE cut, so "um, uh, like" is a single
        // clean removal rather than three slivers. A run never crosses from
        // one part of the clip into another.
        let runStart = -1;
        for (let i = 0; i <= view.words.length; i++) {
          const w = view.words[i];
          const prev = view.words[i - 1];
          const isFiller = !!w && w.state === "kept" && fillers.has(w.word.index);
          const continues = isFiller && runStart >= 0 && prev?.sectionId === w.sectionId;
          if (runStart >= 0 && !continues) {
            const range = rangeForWordRun(plain, runStart, i - 1);
            const sectionId = view.words[runStart].sectionId;
            if (range && sectionId) {
              next = commands.remove(sectionId, [range], "filler")(next);
              found += i - runStart;
            }
            runStart = -1;
          }
          if (isFiller && runStart < 0) runStart = i;
        }
        return next;
      });
      if (found === 0) toast.message("No filler words found in this clip");
      else toast.success(`Removed ${found} filler word${found === 1 ? "" : "s"}`);
    } finally {
      setBusy(null);
    }
  };

  const removeSilences = () => {
    let found = 0;
    apply((d) =>
      d.sections.reduce((acc, section) => {
        const silences = findSilences(session.words, section);
        found += silences.length;
        return commands.remove(section.id, silences, "silence")(acc);
      }, d),
    );
    if (found === 0) toast.message("No long pauses in this clip");
  };

  // ── Export / kill ────────────────────────────────────────────────────────
  const exportClip = async () => {
    setBusy("export");
    let navigating = false;
    try {
      if (!(await save())) {
        toast.error("Couldn't save your edits — export cancelled");
        return;
      }
      const res = await fetch(`/api/clip-ideas/${session.clipIdea.id}/editor/export`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        productionItemId?: string;
        brand?: string;
        error?: string;
      };
      if (!res.ok || !json.productionItemId) {
        toast.error(json.error ?? `Export failed (${res.status})`);
        return;
      }
      // Straight to the clip's page. Deliberately NOT closing the dialog or
      // refreshing the queue first: both re-render the queue underneath and
      // read as "bounced back to the queue" while the next page loads. The
      // editor stays up (with a "Opening your clip…" cover) until the route
      // change unmounts it. The content page's status chip takes over from
      // here — it shows the render progress.
      const target = `/${json.brand ?? brand}/content/${json.productionItemId}`;
      if (window.location.pathname === target) {
        // Re-export from the clip's own page: there is nowhere to go, and a
        // push to the current URL would never unmount us (the cover would
        // hang). Just close; the page's status chip picks up the new render.
        onDone();
        onClose();
        return;
      }
      navigating = true;
      setLeaving(true);
      router.push(target);
    } finally {
      // Keep the button busy while the next page loads — re-enabling it would
      // invite a second export.
      if (!navigating) setBusy(null);
    }
  };

  const killIdea = async (reason: string | null) => {
    setBusy("kill");
    try {
      const res = await fetch(`/api/clip-ideas/${session.clipIdea.id}/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "kill", killReason: reason }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error(json?.error ?? `Failed (${res.status})`);
        return;
      }
      setKillOpen(false);
      onDone();
      onClose();
    } finally {
      setBusy(null);
    }
  };

  const originalSec = session.clipIdea.endSec - session.clipIdea.startSec;
  const vertical = doc.canvas.height > doc.canvas.width;

  return (
    <>
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3 pr-12">
        <DialogTitle className="text-base font-semibold">The Clip</DialogTitle>
        {session.clipIdea.targetFormat && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {session.clipIdea.targetFormat}
          </span>
        )}
        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-800 dark:bg-sky-950 dark:text-sky-300">
          Editor beta
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {fmtDuration(plan.durationSec)}
          {Math.abs(plan.durationSec - originalSec) >= 0.5 && (
            <span className="ml-1 opacity-70">
              (was {fmtDuration(originalSec)})
            </span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <SaveIndicator state={saveState} onRetry={() => void save()} />
          <IconButton label="Undo (⌘Z)" disabled={!canUndo || locked} onClick={undo}>
            <Undo2Icon className="size-4" />
          </IconButton>
          <IconButton label="Redo (⇧⌘Z)" disabled={!canRedo || locked} onClick={redo}>
            <Redo2Icon className="size-4" />
          </IconButton>
        </div>
      </div>

      {locked && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900">
          <AlertTriangleIcon className="size-3.5" />
          This clip was changed in another tab, so this copy is out of date.
          <button
            type="button"
            className="font-medium underline"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      )}

      {/* Workspace */}
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-5 px-5 py-4",
          // Vertical canvas: the stage is as tall as the workspace and its
          // width follows from the aspect ratio. Landscape: it takes a share
          // of the width instead.
          vertical
            ? "grid-cols-[minmax(0,1fr)_auto_280px]"
            : "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_280px]",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <h3 className="mr-auto text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Transcript
            </h3>
            {fillerCount > 0 ? (
              <ToolButton disabled={locked} onClick={() => apply(commands.restoreAll("filler"))}>
                Restore {fillerCount} filler cut{fillerCount === 1 ? "" : "s"}
              </ToolButton>
            ) : (
              <ToolButton disabled={locked || busy !== null} onClick={() => void removeFillers()}>
                {busy === "fillers" ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <SparklesIcon className="size-3" />
                )}
                Remove filler words
              </ToolButton>
            )}
            {silenceCount > 0 ? (
              <ToolButton disabled={locked} onClick={() => apply(commands.restoreAll("silence"))}>
                Restore {silenceCount} pause{silenceCount === 1 ? "" : "s"}
              </ToolButton>
            ) : (
              <ToolButton disabled={locked} onClick={removeSilences}>
                <TimerOffIcon className="size-3" />
                Remove pauses
              </ToolButton>
            )}
          </div>
          {session.wordsSynthetic && (
            <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
              This source only has caption-level timing, so word cuts are
              approximate. Re-run the transcript for frame-accurate edits.
            </p>
          )}
          <TranscriptEditor view={view} doc={doc} plan={plan} engine={engine} readOnly={locked} />
        </div>

        <div
          className={cn("min-h-0 min-w-0", vertical && "h-full")}
          style={vertical ? { aspectRatio: `${doc.canvas.width} / ${doc.canvas.height}` } : undefined}
        >
          <Stage plan={plan} scene={scene} engine={engine} videoUrl={session.source.videoUrl} />
        </div>

        <Inspector doc={doc} disabled={locked} />
      </div>

      <div className="shrink-0 px-5">
        <Transport
          plan={plan}
          engine={engine}
          sections={doc.sections}
          words={session.words}
          readOnly={locked}
        />
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between px-5 py-3">
        {isReExport ? (
          <a
            href={`/${brand}/content/${session.clipIdea.acceptedProductionItemId ?? ""}`}
            className="text-sm font-medium text-sky-700 hover:underline"
          >
            View content →
          </a>
        ) : (
          <button
            type="button"
            onClick={() => setKillOpen(true)}
            disabled={busy !== null}
            className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            Kill idea
          </button>
        )}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy === "export"}>
            Close
          </Button>
          <Button
            type="button"
            onClick={() => void exportClip()}
            disabled={busy !== null || locked || plan.totalFrames === 0}
          >
            {busy === "export" && <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />}
            {isReExport ? "Re-export clip" : "Export clip"}
          </Button>
        </div>
      </div>

      {leaving && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 rounded-xl bg-background/85 backdrop-blur-sm">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          <span className="text-sm font-medium">Opening your clip…</span>
        </div>
      )}

      <KillIdeaDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        title={session.clipIdea.hook}
        saving={busy === "kill"}
        onConfirm={killIdea}
      />
    </>
  );
}

function SaveIndicator({
  state,
  onRetry,
}: {
  state: "saved" | "dirty" | "saving" | "error" | "conflict";
  onRetry: () => void;
}) {
  if (state === "error") {
    return (
      <button type="button" onClick={onRetry} className="mr-2 text-xs font-medium text-red-600 hover:underline">
        Save failed — retry
      </button>
    );
  }
  return (
    <span className="mr-2 flex items-center gap-1 text-xs text-muted-foreground">
      {state === "saved" ? (
        <>
          <CheckIcon className="size-3" /> Saved
        </>
      ) : state === "conflict" ? (
        "Out of date"
      ) : (
        <>
          <Loader2Icon className="size-3 animate-spin" /> Saving…
        </>
      )}
    </span>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ToolButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium transition-colors hover:bg-muted disabled:opacity-50"
    >
      {children}
    </button>
  );
}
