"use client";

/** Properties of the selected element (or the page). Every control writes
 *  through `apply(commands.…)` — undoable, autosaved. */
import { useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, CameraIcon, CopyIcon, CropIcon, Loader2Icon, LockIcon, Trash2Icon, UnlockIcon, UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { FONT_IDS } from "@/lib/clip-editor/doc";
import { FONTS } from "@/lib/clip-editor/fonts";
import type { DesignCaptionsElement, DesignDoc, DesignElement, DesignImageElement, DesignRectElement, DesignTextElement, DesignVideoElement } from "@/lib/design-editor/doc";
import type { ImageCandidate } from "@/lib/services/design-editor/assets";
import type { DesignFrame, DesignFramesState } from "@/lib/services/design-editor/frames";
import { commands, useDesign } from "./store";

export interface InspectorProps {
  doc: DesignDoc;
  images: ImageCandidate[];
  frames: DesignFramesState;
  source: { videoUrl: string; title: string | null } | null;
  onPickImage: (elementId: string, c: ImageCandidate) => void;
  /** Grab a frame of the source at `sec` and put it in this element when it lands. */
  onGrabFrame: (elementId: string | null, sec: number) => void;
  onUpload: (elementId: string | null, file: File) => Promise<void>;
  /** Enter adjust (pan/zoom) mode on this picture or clip. */
  onAdjust: (elementId: string) => void;
  /** Jump the page's clip preview to this clip time. */
  onSeekClip: (clipSec: number) => void;
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

export function Inspector({ doc, images, frames, source, onPickImage, onGrabFrame, onUpload, onAdjust, onSeekClip }: InspectorProps) {
  const apply = useDesign((s) => s.apply);
  const selection = useDesign((s) => s.selection);
  const select = useDesign((s) => s.select);
  const page = doc.pages[selection.pageIndex];
  const el = page?.elements.find((e) => e.id === selection.elementId) ?? null;
  const pi = selection.pageIndex;

  if (!page) return null;
  if (!el) {
    return (
      <Panel title={`Page ${pi + 1}`}>
        <Color label="Background" value={page.background} onChange={(v) => apply(commands.setPageBackground(pi, v), "page-bg")} />
        <p className="text-[11px] leading-snug text-muted-foreground">Click anything on the page to edit it. Double-click text to type, double-click a picture to reposition it.</p>
        {page.elements.some((e) => e.type === "video") && (
          <p className="text-[11px] leading-snug text-muted-foreground">This is a video slide — it exports as an mp4 of the clip, with everything on the page baked in.</p>
        )}
      </Panel>
    );
  }

  const patch = <E extends DesignElement>(fn: (e: E) => E, key?: string) => apply(commands.patchElement<E>(pi, el.id, fn), key);

  return (
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

      {el.type === "text" && <TextPanel el={el} patch={(fn, key) => patch<DesignTextElement>(fn, key)} />}
      {el.type === "rect" && (
        <Panel title="Fill">
          <Color label="Colour" value={el.fill.color} onChange={(v) => patch<DesignRectElement>((e) => ({ ...e, fill: { ...e.fill, color: v } }), "fill")} />
          <Slider label="Fill opacity" value={el.fill.alpha} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch<DesignRectElement>((e) => ({ ...e, fill: { ...e.fill, alpha: v } }), "fill-a")} />
          <Check label="Fade to a second colour (gradient)" checked={!!el.gradientTo} onChange={(on) => patch<DesignRectElement>((e) => ({ ...e, gradientTo: on ? { color: "#000000", alpha: 0.9 } : null }))} />
          {el.gradientTo && (
            <>
              <Color label="Bottom colour" value={el.gradientTo.color} onChange={(v) => patch<DesignRectElement>((e) => ({ ...e, gradientTo: { ...e.gradientTo!, color: v } }), "grad")} />
              <Slider label="Bottom opacity" value={el.gradientTo.alpha} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch<DesignRectElement>((e) => ({ ...e, gradientTo: { ...e.gradientTo!, alpha: v } }), "grad-a")} />
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
        <PicturePicker title="Swap picture" images={images} frames={frames} source={source} onPick={(c) => onPickImage(el.id, c)} onGrabFrame={(sec) => onGrabFrame(el.id, sec)} onUpload={(file) => onUpload(el.id, file)} />
      )}
      {el.type === "captions" && <CaptionsPanel el={el} patch={(fn, key) => patch<DesignCaptionsElement>(fn, key)} />}
    </div>
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
      <div className="grid grid-cols-2 gap-1">
        <button type="button" onClick={() => patch((c) => ({ ...c, startSec: Math.max(0, c.startSec - 2) }), "trim-startSec")} className="rounded border border-border px-1 py-0.5 text-[11px] hover:bg-muted">Start −2s</button>
        <button type="button" onClick={() => patch((c) => ({ ...c, startSec: Math.min(c.endSec - 1, c.startSec + 2) }), "trim-startSec")} className="rounded border border-border px-1 py-0.5 text-[11px] hover:bg-muted">Start +2s</button>
        <button type="button" onClick={() => patch((c) => ({ ...c, endSec: Math.max(c.startSec + 1, c.endSec - 2) }), "trim-endSec")} className="rounded border border-border px-1 py-0.5 text-[11px] hover:bg-muted">End −2s</button>
        <button type="button" onClick={() => patch((c) => ({ ...c, endSec: c.endSec + 2 }), "trim-endSec")} className="rounded border border-border px-1 py-0.5 text-[11px] hover:bg-muted">End +2s</button>
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{formatSec(el.startSec)} → {formatSec(el.endSec)}</span>
        <span className="font-mono">{len.toFixed(1)}s</span>
      </div>
      <button type="button" onClick={() => onSeekClip(0)} className="rounded border border-border px-2 py-1 text-[11px] hover:bg-muted">Preview from the start</button>
    </div>
  );
}

/**
 * Every picture the design can use: the video's frames (filmstrip, with the
 * AI's pick starred), a scrubber to grab any exact moment, the source's own
 * pictures + wordmarks, and an upload.
 */
export function PicturePicker({ title, images, frames, source, onPick, onGrabFrame, onUpload }: {
  title: string; images: ImageCandidate[]; frames: DesignFramesState; source: { videoUrl: string } | null;
  onPick: (c: ImageCandidate) => void; onGrabFrame: (sec: number) => void; onUpload: (file: File) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const doneFrames = frames.frames.filter((f) => f.status === "done");
  return (
    <Panel title={title}>
      {(doneFrames.length > 0 || frames.pending) && (
        <>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            From the video {frames.pending && <Loader2Icon className="size-3 animate-spin" />}
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
                  {f.isPick && <span className="absolute right-0 top-0 rounded-bl bg-amber-400 px-1 text-[9px] font-semibold text-black">AI pick</span>}
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
      <button type="button" disabled={uploading} onClick={() => fileRef.current?.click()} className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[11px] font-medium hover:bg-muted disabled:opacity-50">
        {uploading ? <Loader2Icon className="size-3 animate-spin" /> : <UploadIcon className="size-3" />} Upload a picture
      </button>
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

function Color({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between text-[11px] text-muted-foreground">
      {label}
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-[10px]">{value.toUpperCase()}</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="size-6 cursor-pointer rounded border border-border bg-transparent p-0" />
      </span>
    </label>
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
