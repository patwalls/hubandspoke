"use client";

/**
 * The floating format bar over a selected text element (Descript-style):
 * font, size, text colour, fill (the box behind it), alignment, and whether
 * it shows for one scene or the whole clip. Everything here also lives in
 * the inspector — this is the quick, on-the-video version.
 */
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon, MinusIcon, PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { FONT_IDS, type TextLayer, type TextStyle } from "@/lib/clip-editor/doc";
import { FONTS } from "@/lib/clip-editor/fonts";

const ALIGN_NEXT: Record<TextStyle["align"], TextStyle["align"]> = { left: "center", center: "right", right: "left" };
const ALIGN_ICON = { left: AlignLeftIcon, center: AlignCenterIcon, right: AlignRightIcon };
/** What "Fill" turns on: one solid box behind the whole text. */
const DEFAULT_FILL = { color: "#2F7FB8", alpha: 1, radiusPct: 10, padPct: 34, mode: "block" as const };

export function TextToolbar({
  layer,
  ownSceneIndex,
  currentSceneIndex,
  onStyle,
  onScope,
}: {
  layer: TextLayer;
  /** The scene this text belongs to (null = whole clip, or its scene is gone). */
  ownSceneIndex: number | null;
  /** The scene picked / under the playhead — where "only" / "Move" pins it. */
  currentSceneIndex: number | null;
  onStyle: (patch: Partial<TextStyle>, coalesceKey?: string) => void;
  /** true = only the current scene; false = the whole clip. */
  onScope: (sceneOnly: boolean) => void;
}) {
  const s = layer.style;
  const Align = ALIGN_ICON[s.align];
  const size = Math.round(s.sizePct * 10) / 10;
  return (
    <div
      role="toolbar"
      aria-label="Text format"
      onPointerDown={(e) => e.stopPropagation()}
      className="pointer-events-auto flex items-center gap-0.5 whitespace-nowrap rounded-lg border border-border bg-popover p-1 text-[12px] shadow-lg"
    >
      <select
        aria-label="Font"
        value={s.fontId}
        onChange={(e) => onStyle({ fontId: e.target.value as TextStyle["fontId"] })}
        className="h-7 max-w-[8.5rem] rounded-md bg-transparent px-1 font-medium hover:bg-muted"
        style={{ fontFamily: `"${FONTS[s.fontId].cssFamily}"`, fontWeight: FONTS[s.fontId].cssWeight }}
      >
        {FONT_IDS.map((id) => (
          <option key={id} value={id}>
            {FONTS[id].label}
          </option>
        ))}
      </select>
      <Sep />
      <IconBtn label="Smaller" onClick={() => onStyle({ sizePct: Math.max(0.5, Math.round((s.sizePct - 0.2) * 10) / 10) }, "tb-size")}>
        <MinusIcon className="size-3.5" />
      </IconBtn>
      <span className="w-8 text-center font-mono tabular-nums" title="Size (% of the frame's height)">
        {size}
      </span>
      <IconBtn label="Bigger" onClick={() => onStyle({ sizePct: Math.min(20, Math.round((s.sizePct + 0.2) * 10) / 10) }, "tb-size")}>
        <PlusIcon className="size-3.5" />
      </IconBtn>
      <Sep />
      <label className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 hover:bg-muted" title="Text colour">
        <span className="flex flex-col items-center leading-none">
          <span className="font-bold">A</span>
          <span className="mt-0.5 h-1 w-3.5 rounded-sm ring-1 ring-black/20" style={{ background: s.color }} />
        </span>
        <input type="color" aria-label="Text colour" value={s.color} onChange={(e) => onStyle({ color: e.target.value.toUpperCase() }, "tb-color")} className="sr-only" />
      </label>
      <label className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 hover:bg-muted" title="Fill colour (the box behind the text)">
        <span className="size-3.5 rounded-sm ring-1 ring-black/20" style={{ background: s.box ? s.box.color : "transparent" }} />
        Fill
        <input
          type="color"
          aria-label="Fill colour"
          value={s.box?.color ?? DEFAULT_FILL.color}
          onChange={(e) => onStyle({ box: { ...(s.box ?? DEFAULT_FILL), color: e.target.value.toUpperCase() } }, "tb-fill")}
          className="sr-only"
        />
      </label>
      {s.box && (
        <IconBtn label="Remove fill" onClick={() => onStyle({ box: null })}>
          <span className="text-[11px] text-muted-foreground">✕</span>
        </IconBtn>
      )}
      <Sep />
      <IconBtn label={`Align ${s.align}`} onClick={() => onStyle({ align: ALIGN_NEXT[s.align] })}>
        <Align className="size-3.5" />
      </IconBtn>
      {layer.role !== "hook" && (<>
      <Sep />
      <div className="flex rounded-md bg-muted p-0.5" title="When it shows">
        <button
          type="button"
          disabled={!layer.sectionId && currentSceneIndex === null}
          onClick={() => !layer.sectionId && onScope(true)}
          className={cn("rounded px-1.5 py-0.5 font-medium disabled:opacity-40", layer.sectionId ? "bg-background shadow-sm" : "text-muted-foreground")}
        >
          {layer.sectionId ? `Scene ${ownSceneIndex ?? "?"} only` : `Scene ${currentSceneIndex ?? "?"} only`}
        </button>
        <button
          type="button"
          onClick={() => onScope(false)}
          className={cn("rounded px-1.5 py-0.5 font-medium", !layer.sectionId ? "bg-background shadow-sm" : "text-muted-foreground")}
        >
          Whole clip
        </button>
      </div>
      {layer.sectionId && currentSceneIndex !== null && currentSceneIndex !== ownSceneIndex && (
        <button
          type="button"
          onClick={() => onScope(true)}
          className="ml-1 rounded-md bg-violet-600 px-2 py-1 font-semibold text-white hover:bg-violet-700"
        >
          Move to scene {currentSceneIndex}
        </button>
      )}
      </>)}
    </div>
  );
}

function Sep() {
  return <span className="mx-0.5 h-5 w-px bg-border" />;
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex size-7 items-center justify-center rounded-md hover:bg-muted">
      {children}
    </button>
  );
}
