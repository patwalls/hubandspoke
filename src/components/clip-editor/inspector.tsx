"use client";

/**
 * Right-hand panel: properties of the hook, captions and video. Every control
 * writes through `apply(commands.…)`, so it is undoable and autosaved like
 * any other edit. Sliders pass a coalesce key so one drag = one undo step.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { CaptionsLayer, ClipEditDoc, TextLayer, TimeRange } from "@/lib/clip-editor/doc";
import { findCaptionsLayer, findHookLayer } from "@/lib/clip-editor/doc";
import { commands, useEditor } from "./store";

const HIGHLIGHTS = ["#FFE14D", "#4ADE80", "#38BDF8", "#FB7185", "#FFFFFF"];

export function Inspector({
  doc,
  intro,
  disabled,
}: {
  doc: ClipEditDoc;
  intro: TimeRange | null;
  disabled: boolean;
}) {
  const apply = useEditor((s) => s.apply);
  const selection = useEditor((s) => s.stageSelection);
  const hook = findHookLayer(doc);
  const captions = findCaptionsLayer(doc);
  const hasIntro = doc.sections.some((s) => s.role === "intro");
  const vertical = doc.canvas.height > doc.canvas.width;

  const patchHook = (patch: (l: TextLayer) => TextLayer, key?: string) =>
    hook && apply(commands.patchLayer<TextLayer>(hook.id, patch), key);
  const patchCaptions = (patch: (l: CaptionsLayer) => CaptionsLayer, key?: string) =>
    captions && apply(commands.patchLayer<CaptionsLayer>(captions.id, patch), key);

  return (
    <fieldset disabled={disabled} className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1 disabled:opacity-60">
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
          <Check
            label="ALL CAPS"
            checked={hook.style.uppercase}
            onChange={(uppercase) =>
              patchHook((l) => ({ ...l, style: { ...l.style, uppercase } }))
            }
          />
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
            max={6}
            step={1}
            format={(v) => String(v)}
            onChange={(n) =>
              patchCaptions(
                (l) => ({ ...l, maxWordsPerCue: n, maxCharsPerCue: Math.max(12, n * 7) }),
                "cap-words",
              )
            }
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Highlight</span>
            <div className="flex items-center gap-1.5">
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
            </div>
          </div>
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
          vertical && (
            <Slider
              label="Position"
              hint="or drag the video"
              value={doc.video.yPct}
              min={0}
              max={100}
              step={0.5}
              onChange={(yPct) => apply(commands.patchVideo({ yPct }), "video-y")}
            />
          )
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

      {intro && (
        <Panel title="Intro">
          <Check
            label="Include the source's intro at the top"
            checked={hasIntro}
            onChange={(on) => apply(commands.setIntro(on ? intro : null))}
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Prepends the opening of the source video ahead of the clip. It
            shows up in the transcript, where you can trim it like anything
            else.
          </p>
        </Panel>
      )}
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
