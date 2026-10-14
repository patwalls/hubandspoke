"use client";

/**
 * The design editor — what the Repurposed queue's modal becomes for users
 * with the `designEditor` flag, on formats that have a template.
 *
 *   open → AI drafts the post (brief + template) → pages you can edit
 *        → Export renders the pages as the item's carousel and moves the item
 *          through the workflow like Accept does.
 *
 * Same conventions as the clip editor: immutable doc + undo, autosave with
 * cross-tab conflicts, URL-independent (the queue's dialog owns open state).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  CaptionsIcon,
  CheckIcon,
  ClapperboardIcon,
  ExternalLinkIcon,
  AtSignIcon,
  BlendIcon,
  ImageIcon,
  LayersIcon,
  LayoutTemplateIcon,
  LinkIcon,
  Loader2Icon,
  MagnetIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  SparklesIcon,
  SquareIcon,
  TrendingUpIcon,
  TypeIcon,
  Undo2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { EstimatedProgressBar } from "@/components/ui/estimated-progress-bar";
import { cn } from "@/lib/utils";
import { CANVAS_SIZES, DEFAULT_CROP, PHOTO_PLACEHOLDER, newElementId, pageDurationSec, pageVideo, resizeCanvas, shadeElement, type DesignDoc, type DesignImageElement, type DesignImageSource, type DesignVideoElement } from "@/lib/design-editor/doc";
import { applyPhotoPick, hasEmptyCutoutSlot } from "@/lib/design-editor/template-fill";
import { statCard } from "@/lib/design-editor/shared";
import { cutOutPicture, cutoutSupported, type CutoutResult } from "@/lib/design-editor/cutout-client";
import { subjectLayerGeometry } from "@/lib/design-editor/cutout-geometry";
import { BRAND_WORDMARKS } from "@/lib/design-editor/brand-assets";
import type { ChannelInfo } from "@/lib/design-editor/channel";
import { applyDmKeyword } from "@/lib/design-editor/template-fill";
import { resolveChannelsInDoc } from "@/lib/design-editor/channel";
import { readSnapEnabled, writeSnapEnabled } from "@/lib/editor/snap";
import { AttachDmKeywordDialog } from "@/components/dashboard/attach-dm-keyword-dialog";
import type { ImageCandidate } from "@/lib/services/design-editor/assets";
import type { DesignFramesState } from "@/lib/services/design-editor/frames";
import type { DesignPhoto, DesignPhotosState } from "@/lib/services/design-editor/photos";
import type { HeroCoverResult } from "@/lib/services/design-editor/hero";
import { storyFrames } from "@/lib/design-editor/story-frames";
import { PostPane } from "@/components/clip-editor/post-pane";
import type { DesignEditorSession } from "@/lib/services/design-editor/session";
import { ClipTrimmer } from "./clip-trimmer";
import { LayersPanel } from "./layers-panel";
import { DesignPostPreview } from "./post-preview";
import { Inspector, PicturePicker, formatSec, frameCandidate } from "./inspector";
import { PageCanvas, PlaybackContext, type PlaybackState } from "./page-canvas";
import { DesignStoreContext, commands, createDesignStore, useDesign, useDesignStoreApi } from "./store";

const AUTOSAVE_DELAY_MS = 900;
const FRAMES_POLL_MS = 2500;
const PHOTOS_POLL_MS = 3000;
// The first-open AI draft ("Usually 15–25 seconds"). Raise it as the draft
// step does more work, so the loading bar stays honest.
// The worker draft measured 39.7s in prod (2026-10-14).
const DRAFT_EXPECTED_MS = 35_000;
const DRAFT_POLL_MS = 2000;
// Room for the job's 3 tries (~40s each + backoff) before giving up.
const DRAFT_GIVE_UP_MS = 5 * 60_000;
const DRAFT_MAX_BLIPS = 5;

export interface DesignEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productionItemId: string;
  brand: string;
  onDone: () => void;
  /** Can't design this item (no template for the format, no transcript, AI
   *  failed) — caller shows the classic dialog. */
  onUnsupported: (message?: string) => void;
}

export function DesignEditorDialog({ open, onOpenChange, productionItemId, brand, onDone, onUnsupported }: DesignEditorDialogProps) {
  const [session, setSession] = useState<DesignEditorSession | null>(null);

  useEffect(() => {
    if (!open) {
      setSession(null);
      return;
    }
    let cancelled = false;
    setSession(null);
    void (async () => {
      // The first open's AI draft runs on the worker: 202 means "still
      // drafting", so poll. A JSON error is the route's verdict (no template,
      // no transcript, the draft failed). Anything else — a dropped
      // connection, Heroku's router page during a deploy — is retried a few
      // times; giving up always says why, never a silent fallback.
      const started = Date.now();
      let blips = 0;
      while (!cancelled) {
        const res = await fetch(`/api/production-items/${productionItemId}/design`).catch(() => null);
        if (cancelled) return;
        if (res?.status === 200) {
          const json = (await res.json().catch(() => null)) as DesignEditorSession | null;
          if (cancelled) return;
          if (json) return setSession(json);
        } else if (res && res.status !== 202) {
          const json = (await res.json().catch(() => null)) as { error?: string } | null;
          if (cancelled) return;
          if (json) return onUnsupported(json.error ?? `Couldn't open the editor (HTTP ${res.status})`);
        }
        if (res?.status !== 202 && ++blips >= DRAFT_MAX_BLIPS) return onUnsupported("Couldn't reach the server to load the draft. Try again in a minute.");
        if (Date.now() - started > DRAFT_GIVE_UP_MS) return onUnsupported("The AI draft is still running after 5 minutes — the worker may be stuck or restarting. Try again in a minute.");
        await new Promise((r) => setTimeout(r, DRAFT_POLL_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, productionItemId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1600px,97vw)]">
        {session ? (
          <Workspace key={session.design.id} session={session} brand={brand} onDone={onDone} onClose={() => onOpenChange(false)} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <DialogTitle className="sr-only">Design</DialogTitle>
            <SparklesIcon className="size-6 animate-pulse text-pink-500" />
            <span className="text-sm font-medium text-foreground">Drafting your post…</span>
            <span className="max-w-sm text-center text-xs">Reading the video&apos;s transcript and your best past posts of this format. Usually 20–40 seconds the first time.</span>
            <EstimatedProgressBar expectedMs={DRAFT_EXPECTED_MS} className="mt-2 max-w-64" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * "item": designing one post (the default). "template": editing a FORMAT's
 * template on the format page — same editor, but slots are editable, there
 * is no AI bar or export, and saving writes the format's template.
 */
export type EditorMode = "item" | "template";

type SaveDoc = (doc: DesignDoc, revision: number) => Promise<{ ok: true; revision: number } | { ok: false; reason: "conflict" | "error" }>;

function Workspace({ session, brand, mode = "item", saveDoc, onDone, onClose }: { session: DesignEditorSession; brand: string; mode?: EditorMode; saveDoc?: SaveDoc; onDone: () => void; onClose: () => void }) {
  const [store] = useState(() => createDesignStore({ doc: session.design.doc, revision: session.design.revision }));
  return (
    <DesignStoreContext.Provider value={store}>
      <Editor session={session} brand={brand} mode={mode} saveDoc={saveDoc} onDone={onDone} onClose={onClose} />
    </DesignStoreContext.Provider>
  );
}

/**
 * The format page's "Edit template" — opens the format's design template
 * (stored, or its built-in preset) in template mode.
 */
/** `initial` opens a draft (a PDF import) instead of the stored template —
 *  nothing is saved until the first edit, which replaces the template. */
export function DesignTemplateDialog({ open, onOpenChange, formatId, formatName, brand, onSaved, initial = null }: { open: boolean; onOpenChange: (open: boolean) => void; formatId: string; formatName: string; brand: string; onSaved: () => void; initial?: { doc: DesignDoc; imageUrls: Record<string, string> } | null }) {
  const [session, setSession] = useState<DesignEditorSession | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!open) {
        await Promise.resolve(); // next tick: not a synchronous setState in the effect
        if (!cancelled) setSession(null);
        return;
      }
      const res = await fetch(`/api/formats/${formatId}/design-template`);
      const json = (await res.json().catch(() => ({}))) as { template?: { doc: DesignDoc } | null; imageUrls?: Record<string, string>; images?: ImageCandidate[]; channels?: ChannelInfo[] };
      if (cancelled) return;
      const doc = initial?.doc ?? json.template?.doc;
      if (!res.ok || !doc) {
        toast.error("Couldn't load the template");
        return onOpenChange(false);
      }
      setSession({
        item: { id: formatId, title: formatName, brand, format: formatName, formatId, status: null, postType: null, sourceItemId: formatId, sourceTitle: `Template · ${formatName}` },
        design: { id: formatId, revision: 0, doc, brief: null, briefInstruction: null },
        imageUrls: { ...(json.imageUrls ?? {}), ...(initial?.imageUrls ?? {}) },
        images: json.images ?? BRAND_WORDMARKS,
        frames: { frames: [], pending: false },
        photos: { photos: [], screensPending: false },
        thumbnail: null,
        post: null,
        source: null,
        words: [],
        channels: json.channels ?? [],
        dmKeyword: null,
        latestRender: null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, formatId, formatName, brand, onOpenChange, initial]);
  const saveDoc: SaveDoc = useCallback(async (doc, revision) => {
    const res = await fetch(`/api/formats/${formatId}/design-template`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ doc }) });
    if (!res.ok) return { ok: false, reason: "error" };
    onSaved();
    return { ok: true, revision: revision + 1 };
  }, [formatId, onSaved]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[94vh] w-[97vw] max-w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1600px,97vw)]">
        {session ? (
          <Workspace key={formatId} session={session} brand={brand} mode="template" saveDoc={saveDoc} onDone={() => onOpenChange(false)} onClose={() => onOpenChange(false)} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <DialogTitle className="sr-only">Design template</DialogTitle>
            <Loader2Icon className="size-5 animate-spin" />
            <span className="text-sm font-medium text-foreground">Opening the template…</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Editor({ session, brand, mode, saveDoc, onDone, onClose }: { session: DesignEditorSession; brand: string; mode: EditorMode; saveDoc?: SaveDoc; onDone: () => void; onClose: () => void }) {
  const isTemplate = mode === "template";
  const router = useRouter();
  const storeApi = useDesignStoreApi();
  const doc = useDesign((s) => s.doc);
  const saveState = useDesign((s) => s.saveState);
  const selection = useDesign((s) => s.selection);
  const select = useDesign((s) => s.select);
  const canUndo = useDesign((s) => s.past.length > 0);
  const canRedo = useDesign((s) => s.future.length > 0);
  const apply = useDesign((s) => s.apply);
  const undo = useDesign((s) => s.undo);
  const redo = useDesign((s) => s.redo);
  const editingId = useDesign((s) => s.editingElementId);

  const [imageUrls, setImageUrls] = useState<Record<string, string>>(session.imageUrls);
  /** The source's own pictures + brand logos; uploads go to `photos`. */
  const images: ImageCandidate[] = session.images;
  const [frames, setFrames] = useState<DesignFramesState>(session.frames);
  const [photos, setPhotos] = useState<DesignPhotosState>(session.photos);
  /** The element a cutout is being made for ("hero" for the hero cover). */
  const [cutoutBusy, setCutoutBusy] = useState<string | null>(null);
  /** A frame grab the user asked for; swapped in when the worker delivers it. */
  const pendingGrab = useRef<{ elementId: string | null; pageIndex: number; sec: number } | null>(null);
  const [busy, setBusy] = useState<null | "regen" | "export" | "hero">(null);
  const [dmKeyword, setDmKeyword] = useState<string | null>(session.dmKeyword);
  const [keywordOpen, setKeywordOpen] = useState(false);
  const channelsInDoc = useMemo(() => resolveChannelsInDoc(doc, session.channels), [doc, session.channels]);
  const [leaving, setLeaving] = useState(false);
  const [tab, setTab] = useState<"design" | "post">("design");
  const [postDrafting, setPostDrafting] = useState(false);
  const [instruction, setInstruction] = useState(session.design.briefInstruction ?? "");
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });
  const [snap, setSnap] = useState(() => (typeof window === "undefined" ? true : readSnapEnabled()));
  const [layersOpen, setLayersOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const page = doc.pages[selection.pageIndex] ?? doc.pages[0];
  const pageIndex = doc.pages.indexOf(page);
  const locked = saveState === "conflict";
  const pageClip = pageVideo(page);
  const clipLen = pageDurationSec(page);

  // ── Clip playback (video slides) ─────────────────────────────────────────
  const [timeSec, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [seekRequest, setSeekRequest] = useState<PlaybackState["seekRequest"]>(null);
  const [sourceDurationSec, setSourceDurationSec] = useState(0);
  const seekClip = useCallback((sec: number) => setSeekRequest({ sec, nonce: Date.now() }), []);
  const playback = useMemo<PlaybackState>(() => ({ timeSec, playing, durationSec: sourceDurationSec, setTime, setPlaying, setDuration: setSourceDurationSec, seekRequest }), [timeSec, playing, seekRequest, sourceDurationSec]);
  useEffect(() => {
    setPlaying(false);
    setTime(0);
  }, [pageIndex]);
  const scale = useMemo(
    () => (stageBox.w && stageBox.h ? Math.min((stageBox.w - 32) / doc.canvas.width, (stageBox.h - 32) / doc.canvas.height) : 0),
    [stageBox, doc.canvas],
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ── Saving (same chain as the clip editor) ──────────────────────────────
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const save = useCallback((): Promise<boolean> => {
    saveChain.current = saveChain.current.then(async () => {
      const { doc: current, savedDoc, revision, saveState: state } = storeApi.getState();
      if (state === "conflict") return false;
      if (current === savedDoc) {
        storeApi.getState().markSaved(current, revision);
        return true;
      }
      storeApi.getState().markSaving();
      try {
        const result = saveDoc
          ? await saveDoc(current, revision)
          : await (async () => {
              const res = await fetch(`/api/production-items/${session.item.id}/design`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ revision, doc: current }),
              });
              if (res.status === 409) return { ok: false as const, reason: "conflict" as const };
              if (!res.ok) return { ok: false as const, reason: "error" as const };
              return { ok: true as const, revision: ((await res.json()) as { revision: number }).revision };
            })();
        if (!result.ok) return (storeApi.getState().markSaveFailed(result.reason), false);
        storeApi.getState().markSaved(current, result.revision);
        return true;
      } catch {
        storeApi.getState().markSaveFailed("error");
        return false;
      }
    });
    return saveChain.current;
  }, [session.item.id, storeApi, saveDoc]);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [doc, saveState, save]);
  useEffect(() => () => void save(), [save]);

  // ── Keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (typing || editingId) return;
      const { selection: sel } = storeApi.getState();
      if (!sel.elementId) return;
      // ⌘] / ⌘[ one step, with ⇧ all the way — Canva/Figma's z-order keys.
      if ((e.metaKey || e.ctrlKey) && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        e.preventDefault();
        if (storeApi.getState().saveState === "conflict") return;
        const up = e.code === "BracketRight";
        apply(e.shiftKey ? commands.moveElementTo(sel.pageIndex, sel.elementId, up ? "front" : "back") : commands.reorderElement(sel.pageIndex, sel.elementId, up ? "forward" : "backward"));
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        apply(commands.removeElement(sel.pageIndex, sel.elementId));
        select({ pageIndex: sel.pageIndex, elementId: null });
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        apply(commands.patchElement(sel.pageIndex, sel.elementId, (el) => ({ ...el, x: el.x + dx, y: el.y + dy })), "nudge");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, undo, redo, select, storeApi, editingId]);

  // ── Frames from the video ────────────────────────────────────────────────
  // Poll while the worker is still grabbing; when the AI's pick lands and the
  // cover has no photo yet, put it there. When a frame the user grabbed
  // lands, put it in the element they grabbed it for.
  useEffect(() => {
    if (!frames.pending || isTemplate) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/production-items/${session.item.id}/design/frames`);
        if (res.ok) setFrames((await res.json()) as DesignFramesState);
      } catch {
        /* next tick */
      }
    }, FRAMES_POLL_MS);
    return () => clearTimeout(t);
  }, [frames, session.item.id]);
  useEffect(() => {
    const pick = frames.frames.find((f) => f.isPick && f.status === "done");
    // The filmstrip's pick — or, once nothing more is coming and there is
    // no pick, the YouTube thumbnail rather than an empty cover.
    const c = pick ? frameCandidate(pick) : !frames.pending && !frames.frames.some((f) => f.status === "pending") ? session.thumbnail : null;
    // Story slides take their own stills as the filmstrip lands.
    const stills = storyFrames(frames.frames);
    if (c || stills.length > 0) {
      const { doc: cur } = storeApi.getState();
      const patched = applyPhotoPick(cur, c?.src ?? null, stills.map((f) => f.src));
      if (patched) {
        const urlFor = (src: DesignImageSource): string | null =>
          c && JSON.stringify(src) === JSON.stringify(c.src) ? c.previewUrl : stills.find((f) => JSON.stringify(f.src) === JSON.stringify(src))?.previewUrl ?? null;
        setImageUrls((m) => ({ ...m, ...Object.fromEntries(patched.elementIds.flatMap((id) => { const u = urlFor(patched.sources[id]); return u ? [[id, u]] : []; })) }));
        apply(() => patched.doc);
      }
    }
    const grab = pendingGrab.current;
    if (grab) {
      const f = frames.frames.find((x) => Math.abs(x.sec - grab.sec) < 0.02);
      if (f?.status === "done") {
        const fc = frameCandidate(f);
        pendingGrab.current = null;
        if (fc) {
          if (grab.elementId) swapImage(grab.elementId, fc, grab.pageIndex);
          else addImage(fc);
        }
        toast.success(`Frame at ${formatSec(f.sec)} is in`);
      } else if (f?.status === "failed") {
        pendingGrab.current = null;
        toast.error("Couldn't grab that frame");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames]);

  // ── The source's photo library (uploads, cutouts, screens) ──────────────
  useEffect(() => {
    if (!photos.screensPending || isTemplate) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/production-items/${session.item.id}/design/photos`);
        if (res.ok) {
          const next = (await res.json()) as DesignPhotosState;
          setPhotos(next);
          if (!next.screensPending) {
            const n = next.photos.filter((p) => p.kind === "screen").length;
            toast(n ? `Found ${n} screen${n === 1 ? "" : "s"} in the video` : "No dashboards or charts found in the video", { description: n ? "They're in the picture panel under “Screens from the video”." : undefined });
          }
        }
      } catch {
        /* next tick */
      }
    }, PHOTOS_POLL_MS);
    return () => clearTimeout(t);
  }, [photos, session.item.id, isTemplate]);

  const findScreens = async (force: boolean) => {
    const res = await fetch(`/api/production-items/${session.item.id}/design/photos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scan: true, force }) });
    if (!res.ok) return void toast.error("Couldn't start the scan");
    setPhotos({ ...((await res.json()) as DesignPhotosState), screensPending: true });
    toast("Scanning the video for revenue screens…", { description: "Dashboards, charts and payout pages the founder showed. A minute or two." });
  };

  const deletePhoto = async (p: DesignPhoto) => {
    const res = await fetch(`/api/production-items/${session.item.id}/design/photos?photoId=${encodeURIComponent(p.id)}`, { method: "DELETE" });
    if (!res.ok) return void toast.error("Couldn't remove that picture");
    setPhotos((s) => ({ ...s, photos: s.photos.filter((x) => x.id !== p.id) }));
  };

  /** Store a picture in the source's library; returns the entry. */
  const uploadToLibrary = async (file: File | Blob, name: string, kind: "upload" | "cutout", cutoutOf: DesignImageSource | null = null): Promise<DesignPhoto | null> => {
    const body = new FormData();
    body.append("file", file, name);
    body.append("kind", kind);
    if (cutoutOf) body.append("cutoutOf", JSON.stringify(cutoutOf));
    const res = await fetch(`/api/production-items/${session.item.id}/design/upload`, { method: "POST", body });
    const json = (await res.json().catch(() => ({}))) as { photo?: DesignPhoto; error?: string };
    if (!res.ok || !json.photo) {
      toast.error(json.error ?? "Upload failed");
      return null;
    }
    const photo = json.photo;
    setPhotos((s) => ({ ...s, photos: [photo, ...s.photos.filter((x) => !(x.kind === "cutout" && photo.kind === "cutout" && x.sourceKey === photo.sourceKey))] }));
    return photo;
  };

  /** Cut the person out of a picture in the browser → the library. */
  const makeCutout = async (previewUrl: string, name: string, cutoutOf: DesignImageSource): Promise<{ photo: DesignPhoto; cut: CutoutResult } | null> => {
    if (!cutoutSupported()) {
      toast.error("Cutouts need a browser");
      return null;
    }
    const id = `cutout-${name}`;
    toast.loading("Cutting the person out…", { id, description: "Runs on your machine. The first time downloads the model (about 115 MB)." });
    try {
      const result = await cutOutPicture({ url: previewUrl, src: cutoutOf }, (msg) => toast.loading(msg, { id }));
      const photo = await uploadToLibrary(result.blob, `${name.replace(/\.[^.]+$/, "")}.png`, "cutout", cutoutOf);
      if (photo) toast.success("Background removed", { id, description: "The cutout is saved with the video for every post made from it." });
      else toast.dismiss(id);
      return photo ? { photo, cut: result } : null;
    } catch (err) {
      toast.error("Couldn't remove the background", { id, description: err instanceof Error ? err.message : undefined });
      return null;
    }
  };

  const cutoutElement = async (elementId: string) => {
    const el = page.elements.find((e) => e.id === elementId);
    const url = imageUrls[elementId];
    if (!el || el.type !== "image" || !url || cutoutBusy) return;
    setCutoutBusy(elementId);
    try {
      const made = await makeCutout(url, el.name || "picture", el.src);
      if (!made) return;
      const { photo } = made;
      const ratio = photo.width && photo.height ? photo.height / photo.width : null;
      setImageUrls((m) => ({ ...m, [elementId]: photo.previewUrl }));
      apply(commands.patchElement(pageIndex, elementId, (cur) => (cur.type === "image" ? { ...cur, src: photo.src, name: photo.label, fit: "contain", crop: { ...DEFAULT_CROP }, ...(ratio ? { h: Math.round(cur.w * ratio) } : {}) } : cur)));
    } finally {
      setCutoutBusy(null);
    }
  };

  /** Remove background as two layers: the picture stays put (renamed
   *  "· background") and the cut-out person lands on a new layer right
   *  above it, lined up to the pixel — so whatever goes between the two
   *  (a stat card, a shape, text) sits behind the person. One undo step. */
  const splitElement = async (elementId: string) => {
    const el = page.elements.find((e) => e.id === elementId);
    const url = imageUrls[elementId];
    if (!el || el.type !== "image" || !url || cutoutBusy) return;
    setCutoutBusy(elementId);
    try {
      const made = await makeCutout(url, el.name || "picture", el.src);
      if (!made) return;
      const { photo, cut } = made;
      const { doc: cur } = storeApi.getState();
      const base = cur.pages[pageIndex]?.elements.find((e) => e.id === elementId);
      if (!base || base.type !== "image") return;
      const geo = subjectLayerGeometry(base, cut.source, cut.bounds);
      if (!geo) return void toast.error("The person is outside this picture's frame", { description: "Reposition the picture so they're in view, then try again." });
      const name = (base.name || "picture").replace(/ · background$/, "");
      const subject: DesignImageElement = { ...base, ...geo, id: newElementId("image"), name: `${name} · subject`, src: photo.src, radius: 0, slot: null, stack: null, locked: false };
      if (!geo.rotation) delete subject.rotation;
      setImageUrls((m) => ({ ...m, [subject.id]: photo.previewUrl }));
      const at = cur.pages[pageIndex].elements.findIndex((e) => e.id === elementId) + 1;
      apply((d) => commands.addElement(pageIndex, subject, at)(commands.patchElement(pageIndex, elementId, (e) => ({ ...e, name: `${name} · background` }))(d)));
      select({ pageIndex, elementId: subject.id });
      toast.success("Split into two layers", { description: "The person is its own layer above the background. Add a stat card or shape, then drag it between them in Layers." });
    } finally {
      setCutoutBusy(null);
    }
  };

  const grabFrame = async (elementId: string | null, sec: number) => {
    pendingGrab.current = { elementId, pageIndex, sec: Math.round(sec * 100) / 100 };
    const res = await fetch(`/api/production-items/${session.item.id}/design/frames`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ atSec: sec }) });
    if (!res.ok) return void toast.error("Couldn't request that frame");
    setFrames((f) => ({ ...f, pending: true }));
    toast("Grabbing that frame…", { description: "A few seconds. It'll drop in automatically." });
  };

  const rerunFrames = async () => {
    const res = await fetch(`/api/production-items/${session.item.id}/design/frames`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) });
    if (!res.ok) return void toast.error("Couldn't restart the frames");
    setFrames({ ...((await res.json()) as DesignFramesState), pending: true });
    toast("Grabbing frames again…");
  };

  /** Upload photos of the founder into the source's library; the first
   *  one goes into the element (or onto the page) right away. */
  const upload = async (elementId: string | null, files: File[]) => {
    let first: DesignPhoto | null = null;
    for (const file of files) {
      const photo = await uploadToLibrary(file, file.name, "upload");
      if (photo && !first) first = photo;
    }
    if (!first) return;
    if (elementId) swapImage(elementId, first);
    else addImage(first);
    if (files.length > 1) toast.success(`${files.length} photos added`, { description: "They stay with the source video for every post made from it." });
  };

  // ── Adding things ────────────────────────────────────────────────────────
  const addText = () => {
    const id = newElementId("t");
    apply(
      commands.addElement(pageIndex, {
        id, name: "Text", type: "text", x: 90, y: 440, w: 900, h: 200, opacity: 1, locked: false,
        spans: [{ text: "Your text here" }],
        style: { fontId: "montserrat-extrabold", sizePx: 64, lineHeight: 1.15, letterSpacing: 0, color: page.background === "#F7F5EF" ? "#1C1C1E" : "#FFFFFF", align: "center", valign: "middle", uppercase: false, shadow: null, autoFit: true, minSizePx: 16 },
        slot: null, stack: null,
      }),
    );
    select({ pageIndex, elementId: id });
  };
  const addShade = () => {
    const el = shadeElement(doc.canvas, "bottom");
    // Straight above the last picture on the page (under any text) — the
    // z-order a shade needs to do its job.
    const lastImage = page.elements.map((e, i) => (e.type === "image" || e.type === "video" ? i : -1)).filter((i) => i >= 0).pop();
    apply(commands.addElement(pageIndex, el, lastImage === undefined ? 0 : lastImage + 1));
    select({ pageIndex, elementId: el.id });
  };
  const addStatCard = () => {
    const W = doc.canvas.width;
    const el = statCard({ x: Math.round(W * 0.06), y: Math.round(doc.canvas.height * 0.17), w: Math.round(W * 0.5), h: Math.round(doc.canvas.height * 0.3) }, { rotation: -6 });
    apply(commands.addElement(pageIndex, el));
    select({ pageIndex, elementId: el.id });
  };
  const addRect = () => {
    const id = newElementId("r");
    apply(commands.addElement(pageIndex, { id, name: "Box", type: "rect", x: 140, y: 140, w: 800, h: 300, opacity: 1, locked: false, fill: { color: "#22E07A", alpha: 1 }, gradientTo: null, gradientDirection: "down", radius: 24, slot: null, stack: null }));
    select({ pageIndex, elementId: id });
  };
  const addImage = (c: ImageCandidate) => {
    const id = newElementId("img");
    setImageUrls((m) => ({ ...m, [id]: c.previewUrl }));
    apply(commands.addElement(pageIndex, { id, name: c.label, type: "image", x: 140, y: 140, w: 800, h: 800, opacity: 1, locked: false, src: c.src, fit: "cover", radius: 0, crop: { ...DEFAULT_CROP }, slot: null, stack: null }));
    select({ pageIndex, elementId: id });
  };
  const swapImage = (elementId: string, c: ImageCandidate, onPage = pageIndex) => {
    setImageUrls((m) => ({ ...m, [elementId]: c.previewUrl }));
    apply(commands.patchElement(onPage, elementId, (el) => (el.type === "image" ? { ...el, src: c.src, name: c.label, crop: { ...DEFAULT_CROP } } : el)));
  };
  const addClip = () => {
    if ((!session.source && !isTemplate) || pageClip) return;
    const id = newElementId("v");
    const W = doc.canvas.width;
    apply(commands.addElement(pageIndex, {
      id, name: "Clip", type: "video", x: 30, y: 214, w: W - 60, h: Math.round(((W - 60) * 9) / 16), opacity: 1, locked: false,
      src: session.source ? { kind: "s3", bucket: session.source.bucket, key: session.source.key } : null,
      startSec: 0, endSec: 20, fit: "cover", radius: 28, crop: { ...DEFAULT_CROP },
      slot: isTemplate ? { kind: "ai", hint: "The moment where the founder explains the tactic. 20–60s, start at a sentence." } : null, stack: null,
    }));
    select({ pageIndex, elementId: id });
  };
  const addPhotoSlot = () => {
    const id = newElementId("img");
    setImageUrls((m) => ({ ...m, [id]: (PHOTO_PLACEHOLDER as { path: string }).path }));
    apply(commands.addElement(pageIndex, { id, name: "Photo", type: "image", x: 0, y: 0, w: doc.canvas.width, h: doc.canvas.height, opacity: 1, locked: false, src: PHOTO_PLACEHOLDER, fit: "cover", radius: 0, crop: { ...DEFAULT_CROP }, slot: { kind: "photo", hint: "" }, stack: null }));
    select({ pageIndex, elementId: id });
  };
  const addChannel = () => {
    const id = newElementId("ch");
    const dark = page.background.toLowerCase() === "#ffffff" || page.background.toUpperCase() === "#F7F5EF" || page.background.toUpperCase() === "#F5F3EE";
    apply(commands.addElement(pageIndex, { id, name: "Channel", type: "channel", x: 60, y: doc.canvas.height - 160, w: 620, h: 68, opacity: 1, locked: false, slot: null, stack: null, accountId: null, platform: (session.channels[0]?.platform as "youtube") ?? "youtube", showFollowers: true, theme: dark ? "light" : "dark" }));
    select({ pageIndex, elementId: id });
  };
  const addCaptions = () => {
    const id = newElementId("c");
    const dark = page.background.toLowerCase() === "#ffffff" || page.background === "#F7F5EF";
    apply(commands.addElement(pageIndex, { id, name: "Captions", type: "captions", x: 60, y: 60, w: doc.canvas.width - 120, h: 130, opacity: 1, locked: false, maxWordsPerCue: 12, style: { fontId: "inter-regular", sizePx: 32, lineHeight: 1.25, letterSpacing: 0, color: dark ? "#5C5C5C" : "#FFFFFF", align: "center", valign: "middle", uppercase: false, shadow: null, autoFit: true, minSizePx: 20 }, slot: null, stack: null }));
    select({ pageIndex, elementId: id });
  };

  // ── AI / export ──────────────────────────────────────────────────────────
  const regenerate = async () => {
    setBusy("regen");
    try {
      const res = await fetch(`/api/production-items/${session.item.id}/design/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const json = (await res.json().catch(() => ({}))) as DesignEditorSession & { error?: string };
      if (!res.ok) return void toast.error(json.error ?? `Couldn't regenerate (${res.status})`);
      setImageUrls(json.imageUrls);
      storeApi.getState().replaceDoc(json.design.doc, json.design.revision);
      toast.success("New draft ready", { description: "Undo history starts fresh from this draft." });
    } finally {
      setBusy(null);
    }
  };

  /** Rebuild page 1 as the hero cover: AI fill on the server, then the
   *  cutout in the browser if the library doesn't have one yet. */
  const heroCover = async () => {
    setBusy("hero");
    const toastId = "hero-cover";
    toast.loading("Designing the hero cover…", { id: toastId, description: "Headline, footer and the stat card from the transcript — about 15 seconds." });
    try {
      const cover = doc.pages[0];
      const currentHeadline = cover?.elements
        .filter((e): e is Extract<typeof e, { type: "text" }> => e.type === "text" && e.slot?.kind === "ai")
        .sort((a, b) => b.style.sizePx - a.style.sizePx)[0]
        ?.spans.map((s) => s.text).join("") ?? null;
      const res = await fetch(`/api/production-items/${session.item.id}/design/hero`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canvas: doc.canvas, currentHeadline, instruction: instruction || null }),
      });
      const json = (await res.json().catch(() => ({}))) as HeroCoverResult & { error?: string };
      if (!res.ok || !json.page) return void toast.error(json.error ?? `Couldn't design the cover (${res.status})`, { id: toastId });
      setImageUrls((m) => ({ ...m, ...json.imageUrls }));
      apply(commands.replacePage(0, json.page));
      select({ pageIndex: 0, elementId: null });
      const needsCutout = hasEmptyCutoutSlot({ ...doc, pages: [json.page] });
      if (!needsCutout) return void toast.success("Hero cover ready", { id: toastId, description: "Undo (⌘Z) brings the old cover back." });
      if (!json.pick) return void toast.success("Hero cover ready — no cover photo yet", { id: toastId, description: "The video's frames are still being made. Select the cutout slot and swap a picture in, then Remove background." });
      toast.success("Hero cover ready — cutting the founder out next", { id: toastId });
      setCutoutBusy("hero");
      try {
        const made = await makeCutout(json.pick.previewUrl, "cover", json.pick.src);
        if (!made) return;
        const { photo } = made;
        const { doc: cur } = storeApi.getState();
        const patched = applyPhotoPick(cur, null, [], { src: photo.src, width: photo.width, height: photo.height });
        if (patched) {
          setImageUrls((m) => ({ ...m, ...Object.fromEntries(patched.elementIds.map((id) => [id, photo.previewUrl])) }));
          apply(() => patched.doc);
        }
      } finally {
        setCutoutBusy(null);
      }
    } finally {
      setBusy(null);
    }
  };

  const exportDesign = async () => {
    setBusy("export");
    let navigating = false;
    try {
      if (!(await save())) return void toast.error("Couldn't save your design — export cancelled");
      const res = await fetch(`/api/production-items/${session.item.id}/design/export`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { productionItemId?: string; brand?: string; error?: string };
      if (!res.ok || !json.productionItemId) return void toast.error(json.error ?? `Export failed (${res.status})`);
      const target = `/${json.brand ?? brand}/content/${json.productionItemId}`;
      if (window.location.pathname === target) {
        onDone();
        onClose();
        return;
      }
      navigating = true;
      setLeaving(true);
      router.push(target);
    } finally {
      if (!navigating) setBusy(null);
    }
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3 pr-12">
        <DialogTitle className="text-base font-semibold">{isTemplate ? "Design template" : "Design"}</DialogTitle>
        {session.item.format && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{session.item.format}</span>}
        <span className="rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-pink-800 dark:bg-pink-950 dark:text-pink-300">Editor beta</span>
        <span className="truncate text-xs text-muted-foreground">{session.item.sourceTitle}</span>
        {session.post && !isTemplate && (
          <div role="tablist" aria-label="Editor tabs" className="ml-2 flex shrink-0 items-center rounded-lg bg-muted p-[3px] text-xs">
            {(["design", "post"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn("flex h-6 items-center gap-1.5 rounded-md px-3 font-medium transition-colors", tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {t === "design" ? "Design" : "Post"}
                {t === "post" && postDrafting && <Loader2Icon className="size-3 animate-spin" />}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <details className="relative">
            <summary className="flex size-7 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title="Options" aria-label="Options">
              <MoreHorizontalIcon className="size-4" />
            </summary>
            <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg" onClick={(e) => (e.currentTarget.closest("details") as HTMLDetailsElement).open = false}>
              {session.item.formatId && (
                <a href={`/${brand}/formats/${session.item.formatId}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted">
                  <LayoutTemplateIcon className="size-3.5 text-muted-foreground" /> {isTemplate ? "Open the format page" : `Open the “${session.item.format}” template`}
                </a>
              )}
              <div className="mt-1 border-t border-border pt-1">
                <div className="px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Canvas size</div>
                {CANVAS_SIZES.map((size) => {
                  const current = doc.canvas.width === size.width && doc.canvas.height === size.height;
                  return (
                    <button
                      key={size.id}
                      type="button"
                      disabled={locked || current}
                      onClick={() => { apply((d) => resizeCanvas(d, size)); toast.success(`Canvas is now ${size.label.toLowerCase()}`, { description: "Everything was stretched to fit — tidy what needs it." }); }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:opacity-100"
                    >
                      <span className={cn("size-3.5 text-center text-[11px] leading-none", current ? "text-foreground" : "text-transparent")}>✓</span>
                      <span className={cn(current && "font-medium")}>{size.label}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">{size.width}×{size.height}</span>
                    </button>
                  );
                })}
              </div>
              {!isTemplate && (
                <>
                  <button type="button" onClick={() => { void navigator.clipboard.writeText(window.location.href); toast.success("Link copied"); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted">
                    <LinkIcon className="size-3.5 text-muted-foreground" /> Copy link to this post
                  </button>
                  <a href={`/${brand}/content/${session.item.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted">
                    <ExternalLinkIcon className="size-3.5 text-muted-foreground" /> Open the content page
                  </a>
                  <button type="button" onClick={() => void regenerate()} disabled={busy !== null || locked} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50">
                    <SparklesIcon className="size-3.5 text-pink-500" /> Re-draft from the template
                  </button>
                </>
              )}
            </div>
          </details>
          <span className="mr-2 flex items-center gap-1 text-xs text-muted-foreground">
            {saveState === "saved" ? (<><CheckIcon className="size-3" /> Draft saved</>) : saveState === "error" ? (<button type="button" onClick={() => void save()} className="text-red-600 hover:underline">Save failed — retry</button>) : saveState === "conflict" ? "Out of date" : (<><Loader2Icon className="size-3 animate-spin" /> Saving draft…</>)}
          </span>
          <IconButton label="Undo (⌘Z)" disabled={!canUndo || locked} onClick={undo}><Undo2Icon className="size-4" /></IconButton>
          <IconButton label="Redo (⇧⌘Z)" disabled={!canRedo || locked} onClick={redo}><Redo2Icon className="size-4" /></IconButton>
        </div>
      </div>

      {locked && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900">
          <AlertTriangleIcon className="size-3.5" /> This design was changed in another tab, so this copy is out of date.
          <button type="button" className="font-medium underline" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}

      {session.post && !isTemplate && (
        <div className={cn("min-h-0 flex-1 px-5 py-4", tab !== "post" && "hidden")}>
          <div className="mx-auto h-full max-w-3xl">
            <PostPane
              post={session.post}
              brand={brand}
              onDraftingChange={setPostDrafting}
              beforeRedraft={save}
              mediaOverride={tab === "post" ? <DesignPostPreview doc={doc} imageUrls={imageUrls} videoUrl={session.source?.videoUrl ?? null} words={session.words} channels={channelsInDoc} /> : undefined}
              dmKeyword={dmKeyword}
              onDmKeywordChange={(slug) => {
                setDmKeyword(slug);
                apply(() => applyDmKeyword(storeApi.getState().doc, slug));
              }}
            />
          </div>
        </div>
      )}
      <div className={cn("grid min-h-0 flex-1 grid-cols-[150px_minmax(0,1fr)_300px] gap-4 px-5 py-4", tab !== "design" && "hidden")}>
        {/* Pages */}
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-1">
          {doc.pages.map((p, i) => (
            <div key={p.id} className="group relative">
              <button type="button" onClick={() => select({ pageIndex: i, elementId: null })} className={cn("w-full overflow-hidden rounded-md ring-2 ring-transparent transition-shadow", i === pageIndex ? "ring-sky-500" : "hover:ring-sky-300")}>
                <PageCanvas doc={doc} page={p} pageIndex={i} imageUrls={imageUrls} videoUrl={session.source?.videoUrl ?? null} words={session.words} channels={channelsInDoc} scale={126 / doc.canvas.width} interactive={false} />
              </button>
              <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-semibold text-white">{i + 1}</span>
              {pageVideo(p) && <span className="absolute right-1 top-1 rounded bg-black/60 px-1 text-[9px] font-semibold uppercase text-white">▶ {Math.round(pageDurationSec(p))}s</span>}
              <div className="mt-1 flex justify-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Tiny onClick={() => apply(commands.movePage(i, -1))} disabled={i === 0}>↑</Tiny>
                <Tiny onClick={() => apply(commands.movePage(i, 1))} disabled={i === doc.pages.length - 1}>↓</Tiny>
                <Tiny onClick={() => apply(commands.duplicatePage(i))}>⧉</Tiny>
                <Tiny onClick={() => { apply(commands.removePage(i)); select({ pageIndex: Math.max(0, i - 1), elementId: null }); }} disabled={doc.pages.length <= 1}>✕</Tiny>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => { apply(commands.addPage(pageIndex, page.background)); select({ pageIndex: pageIndex + 1, elementId: null }); }} className="flex items-center justify-center gap-1 rounded-md border border-dashed border-border py-3 text-xs text-muted-foreground hover:bg-muted">
            <PlusIcon className="size-3.5" /> Page
          </button>
        </div>

        {/* Stage */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Tool onClick={addText} disabled={locked}><TypeIcon className="size-3.5" /> Text</Tool>
            <Tool onClick={addRect} disabled={locked}><SquareIcon className="size-3.5" /> Box</Tool>
            <Tool onClick={addShade} disabled={locked} title="A clear-to-black fade over the lower part of the photo so white text reads on top"><BlendIcon className="size-3.5" /> Shade</Tool>
            <Tool onClick={addStatCard} disabled={locked} title="A dashboard-style revenue card (label, number, period, chart) — tilt it and put the founder's cutout over it"><TrendingUpIcon className="size-3.5" /> Stat card</Tool>
            <div className="relative">
              <details className="group">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] font-medium hover:bg-muted">
                  <ImageIcon className="size-3.5" /> Picture
                </summary>
                <div className="absolute left-0 top-full z-20 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg" onClick={(e) => { if ((e.target as HTMLElement).closest("button[title]")) (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; }}>
                  <PicturePicker title="Add a picture" images={images} frames={frames} photos={photos} source={session.source} brand={brand} onPick={addImage} onGrabFrame={(sec) => void grabFrame(null, sec)} onUpload={(files) => upload(null, files)} onFindScreens={isTemplate ? undefined : (force) => void findScreens(force)} onDeletePhoto={isTemplate ? undefined : (p) => void deletePhoto(p)} />
                </div>
              </details>
            </div>
            {(session.source || isTemplate) && <Tool onClick={addClip} disabled={locked || !!pageClip}><ClapperboardIcon className="size-3.5" /> Clip</Tool>}
            {isTemplate && <Tool onClick={addPhotoSlot} disabled={locked}><ImageIcon className="size-3.5" /> Photo slot</Tool>}
            {pageClip && <Tool onClick={addCaptions} disabled={locked}><CaptionsIcon className="size-3.5" /> Captions</Tool>}
            <Tool onClick={addChannel} disabled={locked}><AtSignIcon className="size-3.5" /> Channel</Tool>
            <button
              type="button"
              onClick={() => { const next = !snap; setSnap(next); writeSnapEnabled(next); }}
              title="Snap to the canvas centre, edges and other elements while dragging (hold ⌥ to drag freely)"
              className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium", snap ? "border-pink-300 bg-pink-50 text-pink-800 dark:bg-pink-950/40 dark:text-pink-200" : "border-border bg-background text-muted-foreground hover:bg-muted")}
            >
              <MagnetIcon className="size-3.5" /> Snap
            </button>
            <button
              type="button"
              onClick={() => setLayersOpen((o) => !o)}
              aria-pressed={layersOpen}
              title="Everything on this page, top first — click to select, drag or use the arrows to send things forward and back (⌘] / ⌘[)"
              className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium", layersOpen ? "border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200" : "border-border bg-background text-muted-foreground hover:bg-muted")}
            >
              <LayersIcon className="size-3.5" /> Layers
            </button>
            <span className="ml-auto text-[11px] text-muted-foreground">Page {pageIndex + 1} of {doc.pages.length} · double-click text to edit · ⌫ deletes · arrows nudge</span>
          </div>
          <PlaybackContext.Provider value={playback}>
            {/* Clicking the grey around the page deselects — the page then shows exactly what exports, no editor chrome. */}
            <div ref={stageRef} onPointerDown={(e) => { if (e.target === e.currentTarget) select({ pageIndex, elementId: null }); }} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted/40">
              {scale > 0 && (
                <PageCanvas doc={doc} page={page} pageIndex={pageIndex} imageUrls={imageUrls} videoUrl={session.source?.videoUrl ?? null} words={session.words} channels={channelsInDoc} scale={scale} interactive={!locked} showSlots={isTemplate} snap={snap} className="shadow-xl ring-1 ring-black/20" />
              )}
              {layersOpen && (
                <div className="absolute bottom-2 left-2 top-2 z-10 flex items-start">
                  <LayersPanel page={page} pageIndex={pageIndex} disabled={locked} onClose={() => setLayersOpen(false)} />
                </div>
              )}
            </div>
          </PlaybackContext.Provider>
          {pageClip && (
            <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-1.5">
              <button type="button" aria-label={playing ? "Pause" : "Play clip"} onClick={() => setPlaying(!playing)} className="flex size-7 items-center justify-center rounded-full bg-foreground text-background">
                {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
              </button>
              <input type="range" min={0} max={Math.max(0.1, clipLen)} step={0.05} value={Math.min(timeSec, clipLen)} onChange={(e) => seekClip(Number(e.target.value))} className="h-1 min-w-0 flex-1 cursor-pointer accent-sky-500" />
              <span className="font-mono text-[11px] text-muted-foreground">{formatSec(timeSec)} / {formatSec(clipLen)}</span>
              <span className="text-[11px] text-muted-foreground">Video slide · exports as an mp4</span>
            </div>
          )}
          {pageClip && !isTemplate && (
            <ClipTrimmer
              el={pageClip}
              words={session.words}
              durationSec={sourceDurationSec}
              patch={(fn, key) => apply(commands.patchElement<DesignVideoElement>(pageIndex, pageClip.id, fn), key)}
              onPlayFrom={(sec) => { seekClip(sec); setPlaying(true); }}
            />
          )}
        </div>

        <Inspector doc={doc} mode={mode} images={images} frames={frames} photos={photos} source={session.source} brand={brand} onPickImage={swapImage} onGrabFrame={(elementId, sec) => void grabFrame(elementId, sec)} onUpload={upload} onCutout={isTemplate ? undefined : (id) => void cutoutElement(id)} onSplit={isTemplate ? undefined : (id) => void splitElement(id)} cutoutBusy={cutoutBusy} onFindScreens={isTemplate ? undefined : (force) => void findScreens(force)} onDeletePhoto={isTemplate ? undefined : (p) => void deletePhoto(p)} onAdjust={(id) => storeApi.getState().setEditing(id)} onSeekClip={(sec) => { seekClip(sec); setPlaying(true); }} channels={session.channels} dmKeyword={dmKeyword} onChangeDmKeyword={isTemplate ? undefined : () => setKeywordOpen(true)} onRerunFrames={isTemplate ? undefined : () => void rerunFrames()} />
        {!isTemplate && (
          <AttachDmKeywordDialog
            open={keywordOpen}
            onOpenChange={setKeywordOpen}
            itemId={session.item.id}
            currentSlug={dmKeyword}
            baseUrl="https://go.starterstory.com"
            onSaved={async (slug) => {
              setDmKeyword(slug);
              apply(() => applyDmKeyword(storeApi.getState().doc, slug));
              toast.success(slug ? `CTA now uses ${slug.toUpperCase()}` : "Keyword detached");
            }}
          />
        )}
      </div>

      {/* AI bar */}
      {!isTemplate && <div className={cn("flex shrink-0 items-center gap-2 border-t border-border px-5 py-2.5", tab !== "design" && "hidden")}>
        <SparklesIcon className="size-4 shrink-0 text-pink-500" />
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && busy === null) void regenerate(); }}
          placeholder="Tell the AI what to change — “lead with the Reddit moment”, “make the stat about customer calls”, “punchier headline” — then Regenerate"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button type="button" variant="outline" size="sm" onClick={() => void regenerate()} disabled={busy !== null || locked}>
          {busy === "regen" ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : <SparklesIcon className="mr-1.5 size-3.5" />}
          Regenerate
        </Button>
        <Button type="button" size="sm" onClick={() => void heroCover()} disabled={busy !== null || locked || !!cutoutBusy} title="Rebuild the cover like the top posts: the founder cut out of the photo over a dimmed backdrop, a tilted revenue card behind them, the headline in Anton. The instruction on the left steers it." className="bg-pink-600 text-white hover:bg-pink-700">
          {busy === "hero" || cutoutBusy === "hero" ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : <WandSparklesIcon className="mr-1.5 size-3.5" />}
          Hero cover
        </Button>
      </div>}

      <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3">
        <span className="text-xs text-muted-foreground">
          {isTemplate
            ? "Select anything to mark it as a slot the AI fills per post (or a photo / video-title / channel slot). Sample text stays as the style example. Autosaves."
            : `${doc.pages.some((p) => pageVideo(p)) ? "Video slides render on the worker — allow a minute or two. " : ""}${session.design.brief?.caption ? "Export also writes the AI caption into the post draft (if the caption is still empty)." : ""}`}
        </span>
        <div className="flex items-center gap-2">
          {isTemplate ? (
            <Button type="button" onClick={async () => { if (await save()) { toast.success("Template saved"); onClose(); } else toast.error("Couldn't save the template"); }}>
              Save template & close
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={async () => { if (await save()) onClose(); else toast.error("Couldn't save the draft"); }} disabled={busy === "export"}>
                Save draft & close
              </Button>
              <Button type="button" onClick={() => void exportDesign()} disabled={busy !== null || locked}>
                {busy === "export" && <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />}
                {session.latestRender ? "Re-export post" : "Export post"}
              </Button>
            </>
          )}
        </div>
      </div>

      {leaving && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 rounded-xl bg-background/85 backdrop-blur-sm">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          <span className="text-sm font-medium">Opening your post…</span>
        </div>
      )}
    </>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent">
      {children}
    </button>
  );
}

function Tool({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[12px] font-medium hover:bg-muted disabled:opacity-50">
      {children}
    </button>
  );
}

function Tiny({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded border border-border bg-background px-1.5 text-[11px] leading-5 hover:bg-muted disabled:opacity-30">
      {children}
    </button>
  );
}

export type { DesignDoc };
