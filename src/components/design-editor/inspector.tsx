"use client";

/** Properties of the selected element (or the page). Every control writes
 *  through `apply(commands.…)` — undoable, autosaved. */
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, LockIcon, Trash2Icon, UnlockIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { FONT_IDS } from "@/lib/clip-editor/doc";
import { FONTS } from "@/lib/clip-editor/fonts";
import type { DesignDoc, DesignElement, DesignImageElement, DesignRectElement, DesignTextElement } from "@/lib/design-editor/doc";
import type { ImageCandidate } from "@/lib/services/design-editor/assets";
import { commands, useDesign } from "./store";

export function Inspector({ doc, images, onPickImage }: { doc: DesignDoc; images: ImageCandidate[]; onPickImage: (elementId: string, c: ImageCandidate) => void }) {
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
        <p className="text-[11px] leading-snug text-muted-foreground">Click anything on the page to edit it. Double-click text to type.</p>
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
      {el.type === "image" && (
        <Panel title="Image">
          <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-0.5 text-xs">
            {(["cover", "contain"] as const).map((fit) => (
              <button key={fit} type="button" onClick={() => patch<DesignImageElement>((e) => ({ ...e, fit }))} className={cn("rounded px-2 py-1 font-medium", el.fit === fit ? "bg-background shadow-sm" : "text-muted-foreground")}>
                {fit === "cover" ? "Fill" : "Fit"}
              </button>
            ))}
          </div>
          <Slider label="Rounded corners" value={el.radius} min={0} max={200} step={2} format={(v) => `${v}`} onChange={(v) => patch<DesignImageElement>((e) => ({ ...e, radius: v }), "radius")} />
          <span className="text-[11px] text-muted-foreground">Swap picture</span>
          <div className="grid grid-cols-3 gap-1">
            {images.map((c) => (
              <button key={c.label + c.previewUrl} type="button" title={c.label} onClick={() => onPickImage(el.id, c)} className="aspect-square overflow-hidden rounded border border-border bg-black/80 hover:ring-2 hover:ring-sky-400">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.previewUrl} alt={c.label} className="h-full w-full object-contain" />
              </button>
            ))}
          </div>
        </Panel>
      )}
    </div>
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
