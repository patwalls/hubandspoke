"use client";

/**
 * Right-hand panel: properties of the hook, captions and video. Every control
 * writes through `apply(commands.…)`, so it is undoable and autosaved like
 * any other edit. Sliders pass a coalesce key so one drag = one undo step.
 */
import { useMemo, useState, type ReactNode } from "react";
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CaptionsLayer, ClipEditDoc, FontId, TextAlign, TextLayer, TextStyle } from "@/lib/clip-editor/doc";
import { FONT_IDS, TEXT_STYLE_PRESETS, findCaptionsLayer, findHookLayer } from "@/lib/clip-editor/doc";
import { FONTS } from "@/lib/clip-editor/fonts";
import { colorsInClipDoc } from "@/lib/clip-editor/colors";
import { ColorPicker } from "@/components/editor/color-picker";
import { commands, useEditor } from "./store";

const HIGHLIGHTS = ["#FFE14D", "#4ADE80", "#38BDF8", "#FB7185", "#FFFFFF"];

export function Inspector({ doc, disabled }: { doc: ClipEditDoc; disabled: boolean }) {
  const apply = useEditor((s) => s.apply);
  const selection = useEditor((s) => s.stageSelection);
  const hook = findHookLayer(doc);
  const captions = findCaptionsLayer(doc);
  const vertical = doc.canvas.height > doc.canvas.width;

  const patchHook = (patch: (l: TextLayer) => TextLayer, key?: string) =>
    hook && apply(commands.patchLayer<TextLayer>(hook.id, patch), key);
  const patchCaptions = (patch: (l: CaptionsLayer) => CaptionsLayer, key?: string) =>
    captions && apply(commands.patchLayer<CaptionsLayer>(captions.id, patch), key);
  const usedColors = useMemo(() => colorsInClipDoc(doc), [doc]);

  return (
    <fieldset disabled={disabled} className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto pr-1 disabled:opacity-60">
      {hook && (
        <Panel
          title="Hook"
          active={selection?.kind === "layer" && selection.id === hook.id}
          toggle={{
            on: hook.visible,
            onChange: (visible) => patchHook((l) => ({ ...l, visible })),
          }}
        >
          <textarea
            value={hook.text}
            rows={3}
            onChange={(e) => patchHook((l) => ({ ...l, text: e.target.value }), "hook-text")}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="The line that stops the scroll"
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
              patchHook((l) => ({ ...l, style: { ...l.style, sizePct } }), "hook-size")
            }
          />
          <Slider
            label="Position"
            hint="or drag it on the preview"
            value={hook.yPct}
            min={2}
            max={98}
            step={0.5}
            onChange={(yPct) => patchHook((l) => ({ ...l, yPct }), "hook-y")}
          />
          <AlignPicker value={hook.style.align} onChange={(align) => patchHook((l) => ({ ...l, style: { ...l.style, align } }))} />
          <Check
            label="ALL CAPS"
            checked={hook.style.uppercase}
            onChange={(uppercase) =>
              patchHook((l) => ({ ...l, style: { ...l.style, uppercase } }))
            }
          />
          <ColorRow usedColors={usedColors} label="Colour" value={hook.style.color} onChange={(color) => patchHook((l) => ({ ...l, style: { ...l.style, color } }), "hook-color")} />
          <TextEffects style={hook.style} usedColors={usedColors} onChange={(patch, key) => patchHook((l) => ({ ...l, style: { ...l.style, ...patch } }), key)} />
        </Panel>
      )}

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

function Panel({
  title,
  active,
  toggle,
  children,
}: {
  title: string;
  active?: boolean;
  toggle?: { on: boolean; onChange: (on: boolean) => void };
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
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
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
