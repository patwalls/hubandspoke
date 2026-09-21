"use client";

/** Properties of the selected element (or the page). Every control writes
 *  through `apply(commands.…)` — undoable, autosaved. */
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { ColorPicker } from "@/components/editor/color-picker";
import { colorsInDesignDoc } from "@/lib/design-editor/colors";
import { ArrowDownIcon, ArrowUpIcon, CameraIcon, CopyIcon, CropIcon, ImageIcon, Loader2Icon, LockIcon, Trash2Icon, UnlockIcon, UploadIcon } from "lucide-react";
import { LogoPicker } from "@/components/editor/logo-picker";
import { cn } from "@/lib/utils";
import { FONT_IDS } from "@/lib/clip-editor/doc";
import { FONTS } from "@/lib/clip-editor/fonts";
import type { DesignCaptionsElement, DesignChannelElement, DesignDoc, DesignElement, DesignImageElement, DesignRectElement, DesignSlot, DesignTextElement, DesignVideoElement } from "@/lib/design-editor/doc";
import { DM_KEYWORD_TOKEN } from "@/lib/design-editor/doc";
import type { ChannelInfo } from "@/lib/design-editor/channel";
import { formatFollowers } from "@/lib/design-editor/channel";
import type { ImageCandidate } from "@/lib/services/design-editor/assets";
import type { DesignFrame, DesignFramesState } from "@/lib/services/design-editor/frames";
import { commands, useDesign } from "./store";

export interface InspectorProps {
  doc: DesignDoc;
  /** "template": slots are editable (the format page); "item": a post. */
  mode: "item" | "template";
  images: ImageCandidate[];
  frames: DesignFramesState;
  source: { videoUrl: string; title: string | null } | null;
  /** For the brand logo library in the picture panel. */
  brand: string;
  onPickImage: (elementId: string, c: ImageCandidate) => void;
  /** Grab a frame of the source at `sec` and put it in this element when it lands. */
  onGrabFrame: (elementId: string | null, sec: number) => void;
  onUpload: (elementId: string | null, file: File) => Promise<void>;
  /** Enter adjust (pan/zoom) mode on this picture or clip. */
  onAdjust: (elementId: string) => void;
  /** Jump the page's clip preview to this clip time. */
  onSeekClip: (clipSec: number) => void;
  /** The brand's accounts (channel elements) and the post's DM keyword. */
  channels: ChannelInfo[];
  dmKeyword: string | null;
  /** Item mode: open the attach/change keyword dialog. */
  onChangeDmKeyword?: () => void;
  /** Re-run the filmstrip after a failure. */
  onRerunFrames?: () => void;
}

export function frameCandidate(f: DesignFrame): ImageCandidate | null {
  if (!f.src || !f.previewUrl) return null;
  return { label: `Frame at ${formatSec(f.sec)}`, src: f.src, previewUrl: f.previewUrl };
}

export function formatSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Inspector({ doc, mode, images, frames, source, brand, onPickImage, onGrabFrame, onUpload, onAdjust, onSeekClip, channels, dmKeyword, onChangeDmKeyword, onRerunFrames }: InspectorProps) {
  const apply = useDesign((s) => s.apply);
  const selection = useDesign((s) => s.selection);
  const select = useDesign((s) => s.select);
  const page = doc.pages[selection.pageIndex];
  const el = page?.elements.find((e) => e.id === selection.elementId) ?? null;
  const pi = selection.pageIndex;
  const usedColors = useMemo(() => colorsInDesignDoc(doc), [doc]);

  if (!page) return null;
  if (!el) {
    return (
      <UsedColorsContext.Provider value={usedColors}>
      <Panel title={`Page ${pi + 1}`}>
        <Color label="Background" value={page.background} onChange={(v) => apply(commands.setPageBackground(pi, v), "page-bg")} />
        <p className="text-[11px] leading-snug text-muted-foreground">Click anything on the page to edit it. Double-click text to type, double-click a picture to reposition it.</p>
        {page.elements.some((e) => e.type === "video") && (
          <p className="text-[11px] leading-snug text-muted-foreground">This is a video slide — it exports as an mp4 of the clip, with everything on the page baked in.</p>
        )}
      </Panel>
      </UsedColorsContext.Provider>
    );
  }

  const patch = <E extends DesignElement>(fn: (e: E) => E, key?: string) => apply(commands.patchElement<E>(pi, el.id, fn), key);

  return (
    <UsedColorsContext.Provider value={usedColors}>
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
      <Panel title={el.name || el.type}>
        <div className="grid grid-cols-4 gap-1">
          <IconBtn label="Bring forward" onClick={() => apply(commands.reorderElement(pi, el.id, "forward"))}><ArrowUpIcon className="size-3.5" /></IconBtn>
          <IconBtn label="Send backward" onClick={() => apply(commands.reorderElement(pi, el.id, "backward"))}><ArrowDownIcon className="size-3.5" /></IconBtn>
          <IconBtn label="Duplicate" onClick={() => apply(commands.duplicateElement(pi, el.id))}><CopyIcon className="size-3.5" /></IconBtn>
          <IconBtn label={el.locked ? "Unlock" : "Lock"} onClick={() => patch((e) => ({ ...e, locked: !e.locked }))}>{el.locked ? <LockIcon className="size-3.5" /> : <UnlockIcon className="size-3.5" />}</IconBtn>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {(["x", "y", "w", "h"] as const).map((k) => (
            <label key={k} className="flex flex-col gap-0.5 text-[10px] uppercase text-muted-foreground">
              {k}
              <input type="number" value={Math.round(el[k])} onChange={(e) => patch((cur) => ({ ...cur, [k]: Number(e.target.value) }), `num-${k}`)} className="rounded border border-border bg-background px-1 py-0.5 text-[12px] text-foreground" />
            </label>
          ))}
        </div>
        <Slider label="Opacity" value={el.opacity} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch((e) => ({ ...e, opacity: v }), "opacity")} />
        <button type="button" onClick={() => { apply(commands.removeElement(pi, el.id)); select({ pageIndex: pi, elementId: null }); }} className="inline-flex items-center gap-1 self-start rounded-md border border-red-200 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50">
          <Trash2Icon className="size-3" /> Delete
        </button>
      </Panel>

      {mode === "template" && (el.type === "text" || el.type === "image" || el.type === "video") && (
        <SlotPanel el={el} patch={(fn, key) => patch<DesignElement>(fn, key)} />
      )}
      {el.type === "channel" && <ChannelPanel el={el} channels={channels} patch={(fn, key) => patch<DesignChannelElement>(fn, key)} />}
      {el.slot?.kind === "dmKeyword" && el.type === "text" && (
        <Panel title="ManyChat DM keyword">
          {mode === "template" ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              The wording stays as written; <code className="rounded bg-muted px-1">{DM_KEYWORD_TOKEN}</code> becomes the post&apos;s keyword. On a post&apos;s first draft it is attached automatically — the least-used free keyword from the ManyChat pool, pointed at the post&apos;s suggested destination through the usual go→go chain.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-muted-foreground">Keyword</span>
                {dmKeyword ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">{dmKeyword.toUpperCase()}</span> : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">none attached</span>}
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">{dmKeyword ? "Commenting this on the post triggers the ManyChat DM. Clicks and leads track to this post." : "The pool had no free keyword or no destination could be suggested — attach one, or the CTA ships with a placeholder."}</p>
              {onChangeDmKeyword && (
                <button type="button" onClick={onChangeDmKeyword} className="self-start rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted">
                  {dmKeyword ? "Change keyword or destination" : "Attach a keyword"}
                </button>
              )}
            </>
          )}
        </Panel>
      )}
      {mode === "item" && el.slot?.kind === "ai" && (
        <p className="rounded-md border border-dashed border-pink-300/60 bg-pink-50/60 px-2 py-1.5 text-[11px] leading-snug text-pink-900 dark:bg-pink-950/40 dark:text-pink-200">
          <span className="font-semibold">AI wrote this.</span> {el.slot.hint}
        </p>
      )}
      {el.type === "text" && <TextPanel el={el} patch={(fn, key) => patch<DesignTextElement>(fn, key)} />}
      {el.type === "rect" && (
        <Panel title="Fill">
          <div className="grid grid-cols-2 gap-1">
            <button type="button" onClick={() => patch<DesignRectElement>((e) => ({ ...e, fill: { color: "#000000", alpha: 0 }, gradientTo: { color: "#000000", alpha: 0.92 }, gradientDirection: "down" }))} className="rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted" title="Clear at the top, black at the bottom — for white text over the lower half of a photo">
              Fade to black ↓
            </button>
            <button type="button" onClick={() => patch<DesignRectElement>((e) => ({ ...e, fill: { color: "#000000", alpha: 0 }, gradientTo: { color: "#000000", alpha: 0.92 }, gradientDirection: "up" }))} className="rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted" title="Clear at the bottom, black at the top — for white text at the top of a photo">
              Fade to black ↑
            </button>
          </div>
          <Color label={el.gradientTo ? (el.gradientDirection === "up" ? "Bottom (start)" : "Top (start)") : "Colour"} value={el.fill.color} onChange={(v) => patch<DesignRectElement>((e) => ({ ...e, fill: { ...e.fill, color: v } }), "fill")} />
          <Slider label={el.gradientTo ? "Start opacity" : "Opacity"} value={el.fill.alpha} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch<DesignRectElement>((e) => ({ ...e, fill: { ...e.fill, alpha: v } }), "fill-a")} />
          <Check label="Gradient (fade to a second colour)" checked={!!el.gradientTo} onChange={(on) => patch<DesignRectElement>((e) => ({ ...e, gradientTo: on ? { color: "#000000", alpha: 0.92 } : null, fill: on && e.fill.alpha === 1 ? { ...e.fill, alpha: 0 } : e.fill }))} />
          {el.gradientTo && (
            <>
              <Color label={el.gradientDirection === "up" ? "Top (end)" : "Bottom (end)"} value={el.gradientTo.color} onChange={(v) => patch<DesignRectElement>((e) => ({ ...e, gradientTo: { ...e.gradientTo!, color: v } }), "grad")} />
              <Slider label="End opacity" value={el.gradientTo.alpha} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch<DesignRectElement>((e) => ({ ...e, gradientTo: { ...e.gradientTo!, alpha: v } }), "grad-a")} />
              <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-0.5 text-xs">
                {(["down", "up"] as const).map((d) => (
                  <button key={d} type="button" onClick={() => patch<DesignRectElement>((e) => ({ ...e, gradientDirection: d }))} className={cn("rounded px-2 py-1 font-medium", el.gradientDirection === d ? "bg-background shadow-sm" : "text-muted-foreground")}>
                    {d === "down" ? "Darkens downward" : "Darkens upward"}
                  </button>
                ))}
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">Best practice: keep the shade right above the photo in the stack (under the text), cover the lower ~60% and let it reach ~90% black so white type reads without a box.</p>
            </>
          )}
          <Slider label="Rounded corners" value={el.radius} min={0} max={200} step={2} format={(v) => `${v}`} onChange={(v) => patch<DesignRectElement>((e) => ({ ...e, radius: v }), "radius")} />
        </Panel>
      )}
      {(el.type === "image" || el.type === "video") && (
        <Panel title={el.type === "image" ? "Picture" : "Clip"}>
          {el.type === "video" && <ClipTrim el={el} patch={(fn, key) => patch<DesignVideoElement>(fn, key)} onSeekClip={onSeekClip} />}
          <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-0.5 text-xs">
            {(["cover", "contain"] as const).map((fit) => (
              <button key={fit} type="button" onClick={() => patch<DesignImageElement | DesignVideoElement>((e) => ({ ...e, fit }))} className={cn("rounded px-2 py-1 font-medium", el.fit === fit ? "bg-background shadow-sm" : "text-muted-foreground")}>
                {fit === "cover" ? "Fill" : "Fit"}
              </button>
            ))}
          </div>
          {el.fit === "cover" && (
            <>
              <Slider label="Zoom" value={el.crop.zoom} min={1} max={3} step={0.02} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => patch<DesignImageElement | DesignVideoElement>((e) => ({ ...e, crop: { ...e.crop, zoom: v } }), "zoom")} />
              <button type="button" onClick={() => onAdjust(el.id)} className="inline-flex items-center gap-1.5 self-start rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted">
                <CropIcon className="size-3" /> Reposition (or double-click it)
              </button>
            </>
          )}
          <Slider label="Rounded corners" value={el.radius} min={0} max={200} step={2} format={(v) => `${v}`} onChange={(v) => patch<DesignImageElement | DesignVideoElement>((e) => ({ ...e, radius: v }), "radius")} />
        </Panel>
      )}
      {el.type === "image" && (
        <PicturePicker title="Swap picture" images={images} frames={frames} source={source} brand={brand} onPick={(c) => onPickImage(el.id, c)} onGrabFrame={(sec) => onGrabFrame(el.id, sec)} onUpload={(file) => onUpload(el.id, file)} onRerunFrames={onRerunFrames} />
      )}
      {el.type === "captions" && <CaptionsPanel el={el} patch={(fn, key) => patch<DesignCaptionsElement>(fn, key)} />}
    </div>
    </UsedColorsContext.Provider>
  );
}

/**
 * Template mode: what this element IS for every post made from the
 * template — static, written by the AI (with a hint), or filled from the
 * item (the founder's photo, the video title, the channel row) — and
 * whether it stacks with its neighbours.
 */
const SLOT_OPTIONS: Array<{ value: DesignSlot["kind"] | "static"; label: string; for: Array<DesignElement["type"]> }> = [
  { value: "static", label: "Static — same on every post", for: ["text", "image", "video"] },
  { value: "ai", label: "AI writes this per post", for: ["text", "video"] },
  { value: "photo", label: "Founder photo (the video's best shot)", for: ["image"] },
  { value: "frame", label: "A different still of the video per slide", for: ["image"] },
  { value: "videoTitle", label: "The source video's title", for: ["text"] },
  { value: "channelName", label: "Channel name", for: ["text"] },
  { value: "channelSubscribers", label: "Subscriber count", for: ["text"] },
  { value: "dmKeyword", label: "ManyChat DM keyword — {{keyword}} in the text", for: ["text"] },
];

function SlotPanel({ el, patch }: { el: DesignTextElement | DesignImageElement | DesignVideoElement; patch: (fn: (e: DesignElement) => DesignElement, key?: string) => void }) {
  const kind = el.slot?.kind ?? "static";
  const setKind = (value: string) =>
    patch((e) => ({ ...e, slot: value === "static" ? null : { kind: value as DesignSlot["kind"], hint: e.slot?.hint ?? "" } }));
  return (
    <Panel title="Template slot">
      <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground">
        {SLOT_OPTIONS.filter((o) => o.for.includes(el.type)).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {kind === "ai" && (
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          What should the AI write here?
          <textarea
            value={el.slot?.hint ?? ""}
            onChange={(e) => patch((cur) => ({ ...cur, slot: { kind: "ai", hint: e.target.value.slice(0, 400) } }), "slot-hint")}
            onKeyDown={(e) => e.stopPropagation()}
            rows={4}
            placeholder={el.type === "video" ? "e.g. the 20–60s moment where the founder walks through the tech stack" : "e.g. the founder's biggest revenue number, like \"$720K\""}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-[12px] leading-snug text-foreground"
          />
          <span>{el.type === "text" ? "The text on the element now is the AI's style example — keep it real. Colours in it become allowed highlight colours." : "The AI picks the clip's start/end from the transcript."}</span>
        </label>
      )}
      {kind === "photo" && <p className="text-[11px] text-muted-foreground">Filled with the best frame of the source video (AI-picked); the placeholder shows where it goes.</p>}
      {kind === "dmKeyword" && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Write the CTA with <code className="rounded bg-muted px-1">{DM_KEYWORD_TOKEN}</code> where the keyword goes, e.g. comment &quot;{DM_KEYWORD_TOKEN}&quot; and i&apos;ll DM you the full video. Each post gets a real keyword from the ManyChat pool automatically.
        </p>
      )}
      {el.type === "text" && (
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Stack (optional)
          <input
            value={el.stack ?? ""}
            onChange={(e) => patch((cur) => ({ ...cur, stack: e.target.value.trim().slice(0, 40) || null }), "stack")}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="e.g. notes"
            className="rounded-md border border-border bg-background px-2 py-1 text-[12px] text-foreground"
          />
          <span>Elements with the same stack name flow top-to-bottom after filling — text grows to its content, empty ones close up, and the whole stack shrinks to fit the page.</span>
        </label>
      )}
    </Panel>
  );
}

/** Where a clip starts and ends in the source, with a scrubber that also
 *  drives the page's preview. */
function ClipTrim({ el, patch, onSeekClip }: { el: DesignVideoElement; patch: (fn: (e: DesignVideoElement) => DesignVideoElement, key?: string) => void; onSeekClip: (clipSec: number) => void }) {
  const len = Math.max(0, el.endSec - el.startSec);
  const num = (label: string, key: "startSec" | "endSec") => (
    <label className="flex flex-col gap-0.5 text-[10px] uppercase text-muted-foreground">
      {label}
      <input
        type="number" step={0.1} min={0} value={Math.round(el[key] * 10) / 10}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isFinite(v)) return;
          patch((cur) => (key === "startSec" ? { ...cur, startSec: Math.max(0, Math.min(v, cur.endSec - 1)) } : { ...cur, endSec: Math.max(cur.startSec + 1, v) }), `trim-${key}`);
        }}
        className="rounded border border-border bg-background px-1 py-0.5 text-[12px] text-foreground"
      />
    </label>
  );
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-2">
      <div className="grid grid-cols-2 gap-1">
        {num("Start (s)", "startSec")}
        {num("End (s)", "endSec")}
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{formatSec(el.startSec)} → {formatSec(el.endSec)}</span>
        <span className="font-mono">{len.toFixed(1)}s</span>
      </div>
      <button type="button" onClick={() => onSeekClip(0)} className="rounded border border-border px-2 py-1 text-[11px] hover:bg-muted">Preview from the start</button>
      <p className="text-[11px] leading-snug text-muted-foreground">Trim against the transcript in the panel under the slide.</p>
    </div>
  );
}

/**
 * Every picture the design can use: the video's frames (filmstrip, with the
 * AI's pick starred), a scrubber to grab any exact moment, the source's own
 * pictures + wordmarks, and an upload.
 */
export function PicturePicker({ title, images, frames, source, brand, onPick, onGrabFrame, onUpload, onRerunFrames }: {
  title: string; images: ImageCandidate[]; frames: DesignFramesState; source: { videoUrl: string } | null; brand: string;
  onPick: (c: ImageCandidate) => void; onGrabFrame: (sec: number) => void; onUpload: (file: File) => Promise<void>; onRerunFrames?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const doneFrames = frames.frames.filter((f) => f.status === "done");
  const failedOnly = !frames.pending && doneFrames.length === 0 && frames.frames.some((f) => f.status === "failed");
  return (
    <Panel title={title}>
      {failedOnly && onRerunFrames && (
        <button type="button" onClick={onRerunFrames} className="self-start rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100">
          Frames couldn&apos;t be grabbed — try again
        </button>
      )}
      {(doneFrames.length > 0 || frames.pending) && (
        <>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            Photos from the video · AI&apos;s best shots first {frames.pending && <Loader2Icon className="size-3 animate-spin" />}
          </span>
          <div className="grid grid-cols-3 gap-1">
            {frames.frames.map((f) => {
              const c = frameCandidate(f);
              return (
                <button key={f.id} type="button" title={c?.label ?? `Frame at ${formatSec(f.sec)}`} disabled={!c} onClick={() => c && onPick(c)} className={cn("relative aspect-square overflow-hidden rounded border bg-black/80 hover:ring-2 hover:ring-sky-400", f.isPick ? "border-amber-400" : "border-border")}>
                  {c ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.previewUrl} alt={c.label} className="h-full w-full object-cover" />
                  ) : f.status === "failed" ? (
                    <span className="flex h-full items-center justify-center text-[10px] text-red-400">failed</span>
                  ) : (
                    <span className="flex h-full items-center justify-center"><Loader2Icon className="size-3 animate-spin text-white/60" /></span>
                  )}
                  <span className="absolute bottom-0 left-0 rounded-tr bg-black/70 px-1 text-[9px] text-white">{formatSec(f.sec)}</span>
                  {f.rank === 1 ? (
                    <span className="absolute right-0 top-0 rounded-bl bg-amber-400 px-1 text-[9px] font-semibold text-black">AI pick</span>
                  ) : f.rank ? (
                    <span className="absolute right-0 top-0 rounded-bl bg-amber-200 px-1 text-[9px] font-semibold text-black">#{f.rank}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      )}
      {source && <FrameScrubber videoUrl={source.videoUrl} onGrab={onGrabFrame} />}
      {images.length > 0 && (
        <>
          <span className="text-[11px] text-muted-foreground">Other pictures</span>
          <div className="grid grid-cols-3 gap-1">
            {images.map((c) => (
              <button key={c.label + c.previewUrl} type="button" title={c.label} onClick={() => onPick(c)} className="aspect-square overflow-hidden rounded border border-border bg-black/80 hover:ring-2 hover:ring-sky-400">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.previewUrl} alt={c.label} className="h-full w-full object-contain" />
              </button>
            ))}
          </div>
        </>
      )}
      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setUploading(true);
        try { await onUpload(file); } finally { setUploading(false); }
      }} />
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" disabled={uploading} onClick={() => fileRef.current?.click()} className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[11px] font-medium hover:bg-muted disabled:opacity-50">
          {uploading ? <Loader2Icon className="size-3 animate-spin" /> : <UploadIcon className="size-3" />} Upload a picture
        </button>
        {/* The brand's logo library — the same one the clip editor uses. */}
        <LogoPicker
          brand={brand}
          onPick={onPick}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[11px] font-medium hover:bg-muted"
          trigger={<><ImageIcon className="size-3" /> Brand logos</>}
        />
      </div>
    </Panel>
  );
}

/** Scrub the source video and grab the exact frame you're looking at. */
function FrameScrubber({ videoUrl, onGrab }: { videoUrl: string; onGrab: (sec: number) => void }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [sec, setSec] = useState(0);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-2">
      <span className="text-[11px] text-muted-foreground">Grab any moment</span>
      <video ref={ref} src={videoUrl} muted playsInline preload="metadata" onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)} className="w-full rounded bg-black" />
      <input type="range" min={0} max={duration || 1} step={0.1} value={sec} onChange={(e) => { const v = Number(e.target.value); setSec(v); if (ref.current) ref.current.currentTime = v; }} className="h-1 w-full cursor-pointer accent-sky-500" />
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted-foreground">{formatSec(sec)} / {formatSec(duration)}</span>
        <button type="button" onClick={() => onGrab(sec)} className="inline-flex items-center gap-1 rounded-md bg-foreground px-2 py-1 text-[11px] font-medium text-background">
          <CameraIcon className="size-3" /> Use this frame
        </button>
      </div>
    </div>
  );
}

function ChannelPanel({ el, channels, patch }: { el: DesignChannelElement; channels: ChannelInfo[]; patch: (fn: (e: DesignChannelElement) => DesignChannelElement, key?: string) => void }) {
  const platforms = [...new Set(channels.map((c) => c.platform))];
  const selected = (el.accountId && channels.find((c) => c.accountId === el.accountId)) || channels.find((c) => c.platform === el.platform) || null;
  return (
    <Panel title="Channel">
      <p className="text-[11px] leading-snug text-muted-foreground">Avatar, name and follower count come from the account, live — nothing to type.</p>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Account
        <select
          value={el.accountId ?? `platform:${el.platform}`}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("platform:")) patch((cur) => ({ ...cur, accountId: null, platform: v.slice(9) as DesignChannelElement["platform"] }));
            else {
              const c = channels.find((x) => x.accountId === v);
              patch((cur) => ({ ...cur, accountId: v, platform: (c?.platform as DesignChannelElement["platform"]) ?? cur.platform }));
            }
          }}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground"
        >
          {platforms.map((p) => (
            <option key={`platform:${p}`} value={`platform:${p}`}>The brand&apos;s {p} account</option>
          ))}
          {channels.map((c) => (
            <option key={c.accountId} value={c.accountId}>{c.name}{c.handle ? ` (@${c.handle.replace(/^@/, "")})` : ""} · {c.platform}</option>
          ))}
        </select>
      </label>
      {selected && (
        <p className="text-[11px] text-muted-foreground">Showing: {selected.name}{selected.verified ? " ✓" : ""}{formatFollowers(selected.followerCount, selected.platform) ? ` · ${formatFollowers(selected.followerCount, selected.platform)}` : ""}</p>
      )}
      <Check label="Show follower count" checked={el.showFollowers} onChange={(showFollowers) => patch((e) => ({ ...e, showFollowers }))} />
      <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-0.5 text-xs">
        {(["light", "dark"] as const).map((t) => (
          <button key={t} type="button" onClick={() => patch((e) => ({ ...e, theme: t }))} className={cn("rounded px-2 py-1 font-medium", el.theme === t ? "bg-background shadow-sm" : "text-muted-foreground")}>
            {t === "light" ? "Dark text" : "Light text"}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">The box&apos;s height is the avatar size; drag a corner to resize.</p>
    </Panel>
  );
}

function CaptionsPanel({ el, patch }: { el: DesignCaptionsElement; patch: (fn: (e: DesignCaptionsElement) => DesignCaptionsElement, key?: string) => void }) {
  const style = (p: Partial<DesignCaptionsElement["style"]>, key?: string) => patch((e) => ({ ...e, style: { ...e.style, ...p } }), key);
  return (
    <Panel title="Captions">
      <p className="text-[11px] leading-snug text-muted-foreground">Shows what&apos;s being said in the clip, cue by cue, from the transcript.</p>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Font
        <select value={el.style.fontId} onChange={(e) => style({ fontId: e.target.value as DesignCaptionsElement["style"]["fontId"] })} className="rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground">
          {FONT_IDS.map((id) => (<option key={id} value={id}>{FONTS[id].label}</option>))}
        </select>
      </label>
      <Slider label="Size" value={el.style.sizePx} min={12} max={120} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => style({ sizePx: v }, "size")} />
      <Color label="Colour" value={el.style.color} onChange={(v) => style({ color: v }, "color")} />
      <Slider label="Words per cue" value={el.maxWordsPerCue} min={3} max={24} step={1} format={(v) => `${v}`} onChange={(v) => patch((e) => ({ ...e, maxWordsPerCue: Math.round(v) }), "cue-words")} />
      <Check label="ALL CAPS" checked={el.style.uppercase} onChange={(uppercase) => style({ uppercase })} />
      <Check label="Shadow" checked={!!el.style.shadow} onChange={(on) => style({ shadow: on ? { color: "#000000", alpha: 0.8, blur: 12, x: 0, y: 4 } : null })} />
    </Panel>
  );
}

function TextPanel({ el, patch }: { el: DesignTextElement; patch: (fn: (e: DesignTextElement) => DesignTextElement, key?: string) => void }) {
  const style = (p: Partial<DesignTextElement["style"]>, key?: string) => patch((e) => ({ ...e, style: { ...e.style, ...p } }), key);
  return (
    <Panel title="Text">
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Font
        <select value={el.style.fontId} onChange={(e) => style({ fontId: e.target.value as DesignTextElement["style"]["fontId"] })} className="rounded-md border border-border bg-background px-2 py-1.5 text-[13px] text-foreground">
          {FONT_IDS.map((id) => (
            <option key={id} value={id}>{FONTS[id].label}</option>
          ))}
        </select>
      </label>
      <Slider label="Size" value={el.style.sizePx} min={12} max={320} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => style({ sizePx: v }, "size")} />
      <Slider label="Line height" value={el.style.lineHeight} min={0.8} max={2} step={0.02} format={(v) => v.toFixed(2)} onChange={(v) => style({ lineHeight: v }, "lh")} />
      <Color label="Colour" value={el.style.color} onChange={(v) => style({ color: v }, "color")} />
      <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-0.5 text-xs">
        {(["left", "center", "right"] as const).map((a) => (
          <button key={a} type="button" onClick={() => style({ align: a })} className={cn("rounded px-2 py-1 font-medium capitalize", el.style.align === a ? "bg-background shadow-sm" : "text-muted-foreground")}>{a}</button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-0.5 text-xs">
        {(["top", "middle", "bottom"] as const).map((v) => (
          <button key={v} type="button" onClick={() => style({ valign: v })} className={cn("rounded px-2 py-1 font-medium capitalize", el.style.valign === v ? "bg-background shadow-sm" : "text-muted-foreground")}>{v}</button>
        ))}
      </div>
      <Check label="ALL CAPS" checked={el.style.uppercase} onChange={(uppercase) => style({ uppercase })} />
      <Check label="Shrink to fit the box" checked={el.style.autoFit} onChange={(autoFit) => style({ autoFit })} />
      <Check label="Shadow" checked={!!el.style.shadow} onChange={(on) => style({ shadow: on ? { color: "#000000", alpha: 0.8, blur: 20, x: 0, y: 8 } : null })} />
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="mt-2.5 flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="flex h-7 items-center justify-center rounded-md border border-border hover:bg-muted">
      {children}
    </button>
  );
}

function Slider({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex justify-between text-[11px] text-muted-foreground"><span>{label}</span><span className="font-mono">{format(value)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-1 w-full cursor-pointer accent-sky-500" />
    </label>
  );
}

/** Colours used in the open document, for the picker's "In this design"
 *  row. Set by the Inspector so every nested Color field sees the same list. */
const UsedColorsContext = createContext<string[]>([]);

function Color({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const used = useContext(UsedColorsContext);
  return (
    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
      {label}
      <ColorPicker value={value} onChange={onChange} usedColors={used} label={label} />
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[12px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-sky-500" />
      {label}
    </label>
  );
}
