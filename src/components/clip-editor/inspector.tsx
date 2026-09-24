"use client";

/**
 * Right-hand panel: properties of the hook, captions and video. Every control
 * writes through `apply(commands.…)`, so it is undoable and autosaved like
 * any other edit. Sliders pass a coalesce key so one drag = one undo step.
 */
import { useMemo, useState, type ReactNode } from "react";
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon, ChevronDownIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CaptionsLayer, ClipEditDoc, FontId, ImageLayer, TextAlign, TextLayer, TextStyle } from "@/lib/clip-editor/doc";
import { FONT_IDS, TEXT_STYLE_PRESETS, findCaptionsLayer, findHookLayer } from "@/lib/clip-editor/doc";
import { LogoPicker } from "@/components/editor/logo-picker";
import { FONTS } from "@/lib/clip-editor/fonts";
import { colorsInClipDoc } from "@/lib/clip-editor/colors";
import { ColorPicker } from "@/components/editor/color-picker";
import { layoutTextBlock, textToLayoutWords } from "@/lib/clip-editor/layout";
import { fittedStyle } from "@/lib/clip-editor/scene";
import { commands, useEditor } from "./store";

const HIGHLIGHTS = ["#FFE14D", "#4ADE80", "#38BDF8", "#FB7185", "#FFFFFF"];

export function Inspector({ doc, disabled, brand, className }: { doc: ClipEditDoc; disabled: boolean; brand: string; className?: string }) {
  const apply = useEditor((s) => s.apply);
  const selection = useEditor((s) => s.stageSelection);
  const setSelection = useEditor((s) => s.setStageSelection);
  const registerImageUrl = useEditor((s) => s.registerImageUrl);
  const hook = findHookLayer(doc);
  const captions = findCaptionsLayer(doc);
  const vertical = doc.canvas.height > doc.canvas.width;

  const patchCaptions = (patch: (l: CaptionsLayer) => CaptionsLayer, key?: string) =>
    captions && apply(commands.patchLayer<CaptionsLayer>(captions.id, patch), key);
  const usedColors = useMemo(() => colorsInClipDoc(doc), [doc]);
  const removeLayer = (id: string) => {
    apply(commands.removeLayer(id));
    if (selection?.kind === "layer" && selection.id === id) setSelection(null);
  };
  const extraText = doc.layers.filter((l): l is TextLayer => l.type === "text" && l.role !== "hook");
  const images = doc.layers.filter((l): l is ImageLayer => l.type === "image");

  return (
    <fieldset disabled={disabled} className={cn("flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto pr-1 disabled:opacity-60", className)}>
      {hook && (
        <TextLayerPanel
          title="Hook"
          layer={hook}
          active={selection?.kind === "layer" && selection.id === hook.id}
          usedColors={usedColors}
          placeholder="The line that stops the scroll"
          canvas={doc.canvas}
          patch={(patch, key) => apply(commands.patchLayer<TextLayer>(hook.id, patch), key)}
        />
      )}
      {extraText.map((layer, i) => (
        <TextLayerPanel
          key={layer.id}
          title={`Text ${i + 1}`}
          layer={layer}
          active={selection?.kind === "layer" && selection.id === layer.id}
          usedColors={usedColors}
          placeholder="Your text"
          canvas={doc.canvas}
          patch={(patch, key) => apply(commands.patchLayer<TextLayer>(layer.id, patch), key)}
          onRemove={() => removeLayer(layer.id)}
        />
      ))}
      {images.map((layer, i) => (
        <Panel
          key={layer.id}
          title={images.length > 1 ? `Logo ${i + 1}` : "Logo"}
          active={selection?.kind === "layer" && selection.id === layer.id}
          toggle={{ on: layer.visible, onChange: (visible) => apply(commands.patchLayer<ImageLayer>(layer.id, (l) => ({ ...l, visible }))) }}
          onRemove={() => removeLayer(layer.id)}
        >
          <Slider
            label="Size"
            hint="or drag its corner on the preview"
            value={layer.widthPct}
            min={2}
            max={100}
            step={0.5}
            onChange={(widthPct) => apply(commands.patchLayer<ImageLayer>(layer.id, (l) => ({ ...l, widthPct })), `image-size-${layer.id}`)}
          />
          <Slider
            label="Opacity"
            value={Math.round(layer.opacity * 100)}
            min={5}
            max={100}
            step={1}
            onChange={(pct) => apply(commands.patchLayer<ImageLayer>(layer.id, (l) => ({ ...l, opacity: pct / 100 })), `image-opacity-${layer.id}`)}
          />
          <LogoPicker
            brand={brand}
            trigger={<span className="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs hover:bg-muted">Replace picture…</span>}
            onPick={(logo) => {
              apply(commands.patchLayer<ImageLayer>(layer.id, (l) => ({ ...l, src: logo.src })));
              registerImageUrl(layer.id, logo.previewUrl);
            }}
          />
        </Panel>
      ))}

      {captions && (
        <Panel
          title="Captions"
          active={selection?.kind === "layer" && selection.id === captions.id}
          toggle={{
            on: captions.visible,
            onChange: (visible) => patchCaptions((l) => ({ ...l, visible })),
          }}
        >
          <FontPicker
            value={captions.style.fontId}
            onChange={(fontId) =>
              patchCaptions((l) => ({ ...l, style: { ...l.style, fontId } }))
            }
          />
          <Slider
            label="Size"
            value={captions.style.sizePct}
            min={1.5}
            max={8}
            step={0.1}
            onChange={(sizePct) =>
              patchCaptions((l) => ({ ...l, style: { ...l.style, sizePct } }), "cap-size")
            }
          />
          <Spacing style={captions.style} onChange={(patch, key) => patchCaptions((l) => ({ ...l, style: { ...l.style, ...patch } }), `cap-${key}`)} />
          <Slider
            label="Position"
            hint="or drag it on the preview"
            value={captions.yPct}
            min={2}
            max={98}
            step={0.5}
            onChange={(yPct) => patchCaptions((l) => ({ ...l, yPct }), "cap-y")}
          />
          <Slider
            label="Words at a time"
            value={captions.maxWordsPerCue}
            min={1}
            max={12}
            step={1}
            format={(v) => String(v)}
            onChange={(n) =>
              patchCaptions(
                (l) => ({ ...l, maxWordsPerCue: n, maxCharsPerCue: Math.min(120, Math.max(12, n * 8)) }),
                "cap-words",
              )
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-y-1.5">
            <span className="text-[11px] text-muted-foreground">Highlight</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => patchCaptions((l) => ({ ...l, highlightColor: null }))}
                className={cn(
                  "h-5 rounded-full border px-2 text-[10px]",
                  captions.highlightColor === null
                    ? "border-foreground text-foreground"
                    : "border-border text-muted-foreground",
                )}
              >
                Off
              </button>
              {HIGHLIGHTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Highlight ${c}`}
                  onClick={() => patchCaptions((l) => ({ ...l, highlightColor: c }))}
                  className={cn(
                    "size-5 rounded-full border border-black/15",
                    captions.highlightColor === c && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
                  )}
                  style={{ background: c }}
                />
              ))}
              <ColorPicker value={captions.highlightColor ?? "#FFE14D"} onChange={(highlightColor) => patchCaptions((l) => ({ ...l, highlightColor }), "cap-highlight")} usedColors={usedColors} label="Custom highlight" />
            </div>
          </div>
          <ColorRow usedColors={usedColors} label="Colour" value={captions.style.color} onChange={(color) => patchCaptions((l) => ({ ...l, style: { ...l.style, color } }), "cap-color")} />
          <TextEffects style={captions.style} usedColors={usedColors} onChange={(patch, key) => patchCaptions((l) => ({ ...l, style: { ...l.style, ...patch } }), key)} />
          <AlignPicker value={captions.style.align} onChange={(align) => patchCaptions((l) => ({ ...l, style: { ...l.style, align } }))} />
          <Check label="Show punctuation" checked={captions.showPunctuation} onChange={(showPunctuation) => patchCaptions((l) => ({ ...l, showPunctuation }))} />
          <Check
            label="ALL CAPS"
            checked={captions.style.uppercase}
            onChange={(uppercase) =>
              patchCaptions((l) => ({ ...l, style: { ...l.style, uppercase } }))
            }
          />
        </Panel>
      )}

      <Panel title="Video" active={selection?.kind === "video"}>
        <ColorRow usedColors={usedColors} label="Background" value={doc.canvas.background} onChange={(bg) => apply(commands.setBackground(bg), "canvas-bg")} />
        <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-0.5 text-xs">
          {(
            [
              ["contain", "Fit", "Whole frame, letterboxed"],
              ["cover", "Fill", "Crop to fill the canvas"],
            ] as const
          ).map(([fit, label, title]) => (
            <button
              key={fit}
              type="button"
              title={title}
              onClick={() => apply(commands.patchVideo({ fit }))}
              className={cn(
                "rounded px-2 py-1 font-medium transition-colors",
                doc.video.fit === fit
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {doc.video.fit === "contain" ? (
          <>
            <Slider
              label="Size"
              hint="below 100 leaves a margin"
              value={doc.video.scalePct}
              min={50}
              max={100}
              step={1}
              format={(v) => `${Math.round(v)}%`}
              onChange={(scalePct) => apply(commands.patchVideo({ scalePct }), "video-scale")}
            />
            <Slider
              label="Rounded corners"
              value={doc.video.radiusPct}
              min={0}
              max={25}
              step={0.5}
              format={(v) => (v === 0 ? "Off" : v.toFixed(1))}
              onChange={(radiusPct) => apply(commands.patchVideo({ radiusPct }), "video-radius")}
            />
            {(vertical || doc.video.scalePct < 100) && (
              <Slider
                label="Position"
                hint="or drag the video"
                value={doc.video.yPct}
                min={0}
                max={100}
                step={0.5}
                onChange={(yPct) => apply(commands.patchVideo({ yPct }), "video-y")}
              />
            )}
          </>
        ) : (
          <Slider
            label="Pan"
            hint="or drag the video"
            value={doc.video.panXPct}
            min={0}
            max={100}
            step={1}
            onChange={(panXPct) => apply(commands.patchVideo({ panXPct }), "video-pan")}
          />
        )}
      </Panel>

    </fieldset>
  );
}

/** Everything about one text layer: the hook, or an added line of text. */
function TextLayerPanel({ title, layer, active, usedColors, placeholder, canvas, patch, onRemove }: {
  title: string;
  layer: TextLayer;
  active: boolean;
  usedColors: string[];
  placeholder: string;
  canvas: { width: number; height: number };
  patch: (patch: (l: TextLayer) => TextLayer, key?: string) => void;
  onRemove?: () => void;
}) {
  const hook = layer;
  const patchHook = patch;
  const drawnSizePct = fittedStyle(layer, canvas).sizePct;
  /** Shrink to fit on: the box starts as tall as the text is now, so
   *  nothing jumps; drag its top/bottom handles to give it a height. */
  const toggleFit = (on: boolean) =>
    patchHook((l) => {
      if (!on) return { ...l, fitHeightPct: null };
      const block = layoutTextBlock({ words: textToLayoutWords(l.text), style: l.style, canvas, xPct: l.xPct, yPct: l.yPct, anchor: l.anchor, widthPct: l.widthPct, balance: false });
      return { ...l, fitHeightPct: Math.max(2, Math.min(100, ((block.bottom - block.top) / canvas.height) * 100)) };
    });
  return (
        <Panel
          title={title}
          active={active}
          onRemove={onRemove}
          toggle={{
            on: hook.visible,
            onChange: (visible) => patchHook((l) => ({ ...l, visible })),
          }}
        >
          <textarea
            value={hook.text}
            rows={3}
            onChange={(e) => patchHook((l) => ({ ...l, text: e.target.value }), `${layer.id}-text`)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={placeholder}
            data-text-layer={layer.id}
            className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[13px] font-medium leading-snug outline-none focus:ring-2 focus:ring-ring"
          />
          <FontPicker
            value={hook.style.fontId}
            onChange={(fontId) => patchHook((l) => ({ ...l, style: { ...l.style, fontId } }))}
          />
          <Slider
            label="Size"
            value={hook.style.sizePct}
            min={1.5}
            max={8}
            step={0.1}
            onChange={(sizePct) =>
              patchHook((l) => ({ ...l, style: { ...l.style, sizePct } }), `${layer.id}-size`)
            }
          />
          {drawnSizePct < hook.style.sizePct - 0.05 && (
            <p className="-mt-1 text-[11px] text-amber-700 dark:text-amber-400">Shrunk to {drawnSizePct.toFixed(1)} to fit the box</p>
          )}
          <Check label="Shrink to fit the box" checked={hook.fitHeightPct != null} onChange={toggleFit} />
          <Slider
            label="Width"
            hint="or drag its side handles"
            value={hook.widthPct}
            min={10}
            max={100}
            step={1}
            format={(v) => `${Math.round(v)}%`}
            onChange={(widthPct) => patchHook((l) => ({ ...l, widthPct }), `${layer.id}-width`)}
          />
          <Spacing style={hook.style} onChange={(patch, key) => patchHook((l) => ({ ...l, style: { ...l.style, ...patch } }), `${layer.id}-${key}`)} />
          <Slider
            label="Position"
            hint="or drag it on the preview"
            value={hook.yPct}
            min={2}
            max={98}
            step={0.5}
            onChange={(yPct) => patchHook((l) => ({ ...l, yPct }), `${layer.id}-y`)}
          />
          <AlignPicker value={hook.style.align} onChange={(align) => patchHook((l) => ({ ...l, style: { ...l.style, align } }))} />
          <Check
            label="ALL CAPS"
            checked={hook.style.uppercase}
            onChange={(uppercase) =>
              patchHook((l) => ({ ...l, style: { ...l.style, uppercase } }))
            }
          />
          <ColorRow usedColors={usedColors} label="Colour" value={hook.style.color} onChange={(color) => patchHook((l) => ({ ...l, style: { ...l.style, color } }), `${layer.id}-color`)} />
          <TextEffects style={hook.style} usedColors={usedColors} onChange={(patch, key) => patchHook((l) => ({ ...l, style: { ...l.style, ...patch } }), key && `${layer.id}-${key}`)} />
        </Panel>
  );
}

function Panel({
  title,
  active,
  toggle,
  onRemove,
  children,
}: {
  title: string;
  active?: boolean;
  toggle?: { on: boolean; onChange: (on: boolean) => void };
  /** Layers that were added can be taken away again. */
  onRemove?: () => void;
  children: ReactNode;
}) {
  const hidden = toggle && !toggle.on;
  return (
    <section
      className={cn(
        "rounded-lg border bg-card p-3 transition-colors",
        active ? "border-sky-400 ring-1 ring-sky-400/40" : "border-border",
      )}
    >
      <div className="flex items-center justify-between">
        <h3 className="mr-auto text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
        {onRemove && (
          <button type="button" onClick={onRemove} title="Remove" aria-label={`Remove ${title.toLowerCase()}`} className="mr-2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-red-600">
            <Trash2Icon className="size-3.5" />
          </button>
        )}
        {toggle && (
          <button
            type="button"
            role="switch"
            aria-checked={toggle.on}
            aria-label={`Show ${title.toLowerCase()}`}
            onClick={() => toggle.onChange(!toggle.on)}
            className={cn(
              "relative h-4 w-7 rounded-full transition-colors",
              toggle.on ? "bg-sky-500" : "bg-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-3 rounded-full bg-white shadow transition-all",
                toggle.on ? "left-3.5" : "left-0.5",
              )}
            />
          </button>
        )}
      </div>
      {!hidden && <div className="mt-2.5 flex flex-col gap-2.5">{children}</div>}
    </section>
  );
}

/**
 * Collapsed to one row (the current font, drawn in its own face); opens into
 * a grid of every registered font. Inline rather than a popover so it can't
 * be clipped by the dialog. The @font-face rules are already on the page (the
 * stage injects them), so previewing each face costs nothing extra.
 */
function FontPicker({ value, onChange }: { value: FontId; onChange: (id: FontId) => void }) {
  const [open, setOpen] = useState(false);
  const face = (id: FontId) => ({
    fontFamily: `"${FONTS[id].cssFamily}"`,
    fontWeight: FONTS[id].cssWeight,
  });
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">Font</span>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-left text-[14px] leading-tight transition-colors hover:bg-muted"
      >
        <span className="truncate" style={face(value)}>
          {FONTS[value].label}
        </span>
        <ChevronDownIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-1">
          {FONT_IDS.map((id) => (
            <button
              key={id}
              type="button"
              title={FONTS[id].label}
              aria-pressed={value === id}
              onClick={() => {
                onChange(id);
                setOpen(false);
              }}
              className={cn(
                "truncate rounded-md border px-2 py-1.5 text-left text-[13px] leading-tight transition-colors",
                value === id
                  ? "border-sky-500 bg-sky-50 text-foreground dark:bg-sky-950"
                  : "border-border text-foreground/80 hover:bg-muted",
              )}
              style={face(id)}
            >
              {FONTS[id].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Outline / shadow / box for a text layer — the same three controls for the
 * hook and the captions, plus one-click presets. Every value is a % of the
 * font size, so a look survives a size change.
 */
function TextEffects({ style, usedColors, onChange }: { style: TextStyle; usedColors: string[]; onChange: (patch: Partial<TextStyle>, key?: string) => void }) {
  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        {(Object.keys(TEXT_STYLE_PRESETS) as Array<keyof typeof TEXT_STYLE_PRESETS>).map((id) => {
          const p = TEXT_STYLE_PRESETS[id];
          const active = style.outlinePct === p.patch.outlinePct && !!style.shadow === !!p.patch.shadow && !!style.box === !!p.patch.box;
          return (
            <button key={id} type="button" title={p.hint} aria-pressed={active} onClick={() => onChange({ ...p.patch })} className={cn("rounded-md border px-2 py-1 text-[11px] font-medium", active ? "border-sky-400 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-200" : "border-border hover:bg-muted")}>
              {p.label}
            </button>
          );
        })}
      </div>
      <Check label="Outline" checked={style.outlinePct > 0} onChange={(on) => onChange({ outlinePct: on ? 8 : 0 })} />
      {style.outlinePct > 0 && (
        <>
          <ColorRow usedColors={usedColors} label="Outline colour" value={style.outlineColor} onChange={(outlineColor) => onChange({ outlineColor }, "outline-c")} />
          <Slider label="Outline width" value={style.outlinePct} min={1} max={20} step={1} format={(v) => `${Math.round(v)}%`} onChange={(outlinePct) => onChange({ outlinePct }, "outline-w")} />
        </>
      )}
      <Check label="Shadow" checked={!!style.shadow} onChange={(on) => onChange({ shadow: on ? { color: "#000000", alpha: 0.55, blurPct: 14, xPct: 0, yPct: 5 } : null })} />
      {style.shadow && (
        <>
          <ColorRow usedColors={usedColors} label="Shadow colour" value={style.shadow.color} onChange={(color) => onChange({ shadow: { ...style.shadow!, color } }, "shadow-c")} />
          <Slider label="Shadow opacity" value={style.shadow.alpha} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(alpha) => onChange({ shadow: { ...style.shadow!, alpha } }, "shadow-a")} />
          <Slider label="Softness" value={style.shadow.blurPct} min={0} max={40} step={1} format={(v) => `${Math.round(v)}%`} onChange={(blurPct) => onChange({ shadow: { ...style.shadow!, blurPct } }, "shadow-b")} />
          <Slider label="Distance" value={style.shadow.yPct} min={-20} max={30} step={1} format={(v) => `${Math.round(v)}%`} onChange={(yPct) => onChange({ shadow: { ...style.shadow!, yPct } }, "shadow-y")} />
        </>
      )}
      <Check label="Box behind each line" checked={!!style.box} onChange={(on) => onChange({ box: on ? { color: "#000000", alpha: 0.7, radiusPct: 22, padPct: 22 } : null })} />
      {style.box && (
        <>
          <ColorRow usedColors={usedColors} label="Box colour" value={style.box.color} onChange={(color) => onChange({ box: { ...style.box!, color } }, "box-c")} />
          <Slider label="Box opacity" value={style.box.alpha} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(alpha) => onChange({ box: { ...style.box!, alpha } }, "box-a")} />
          <Slider label="Corners" value={style.box.radiusPct} min={0} max={60} step={1} format={(v) => `${Math.round(v)}%`} onChange={(radiusPct) => onChange({ box: { ...style.box!, radiusPct } }, "box-r")} />
          <Slider label="Padding" value={style.box.padPct} min={0} max={60} step={1} format={(v) => `${Math.round(v)}%`} onChange={(padPct) => onChange({ box: { ...style.box!, padPct } }, "box-p")} />
        </>
      )}
    </>
  );
}

function AlignPicker({ value, onChange }: { value: TextAlign; onChange: (align: TextAlign) => void }) {
  const options: Array<{ v: TextAlign; icon: ReactNode; label: string }> = [
    { v: "left", icon: <AlignLeftIcon className="size-3.5" />, label: "Align left" },
    { v: "center", icon: <AlignCenterIcon className="size-3.5" />, label: "Align centre" },
    { v: "right", icon: <AlignRightIcon className="size-3.5" />, label: "Align right" },
  ];
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground">Align</span>
      <div className="grid grid-cols-3 gap-0.5 rounded-md bg-muted p-0.5">
        {options.map((o) => (
          <button key={o.v} type="button" title={o.label} aria-label={o.label} aria-pressed={value === o.v} onClick={() => onChange(o.v)} className={cn("flex h-6 w-8 items-center justify-center rounded", value === o.v ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            {o.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

function ColorRow({ label, value, onChange, usedColors }: { label: string; value: string; onChange: (hex: string) => void; usedColors: string[] }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <ColorPicker value={value} onChange={onChange} usedColors={usedColors} label={label} />
    </div>
  );
}

/** Line and letter spacing — the same two controls as the design editor. */
function Spacing({ style, onChange }: { style: TextStyle; onChange: (patch: Partial<TextStyle>, key: string) => void }) {
  return (
    <>
      <Slider label="Line spacing" value={style.lineHeight ?? 1.18} min={0.7} max={2.5} step={0.02} format={(v) => v.toFixed(2)} onChange={(lineHeight) => onChange({ lineHeight }, "line-height")} />
      <Slider label="Letter spacing" value={style.letterSpacing ?? 0} min={-0.1} max={0.5} step={0.005} format={(v) => (v === 0 ? "0" : v.toFixed(3))} onChange={(letterSpacing) => onChange({ letterSpacing }, "letter-spacing")} />
    </>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between text-[11px] text-muted-foreground">
        <span>
          {label}
          {hint && <span className="ml-1 opacity-60">· {hint}</span>}
        </span>
        <span className="font-mono tabular-nums">{format ? format(value) : value.toFixed(1)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer accent-sky-500"
      />
    </label>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[12px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 accent-sky-500"
      />
      {label}
    </label>
  );
}
