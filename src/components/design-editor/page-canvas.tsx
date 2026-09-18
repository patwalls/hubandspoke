"use client";

/**
 * Draws one page at its true canvas size inside a CSS-scaled box — the same
 * trick as the clip editor's stage, and the same contract: every element is
 * drawn from the same layout the exporter uses (render-tree.ts mirrors this
 * markup node for node), so what you drag is what gets rendered.
 *
 * `interactive` adds selection, drag-to-move, resize handles and inline text
 * editing. Without it the same component is the page thumbnail.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { FONTS, fontFaceCss } from "@/lib/clip-editor/fonts";
import type { DesignDoc, DesignElement, DesignPage, DesignSpan, DesignTextElement, Rgba } from "@/lib/design-editor/doc";
import { layoutDesignText } from "@/lib/design-editor/layout";
import { commands, useDesign } from "./store";

function rgba(c: Rgba): string {
  const r = parseInt(c.color.slice(1, 3), 16);
  const g = parseInt(c.color.slice(3, 5), 16);
  const b = parseInt(c.color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${c.alpha})`;
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

export function PageCanvas({
  doc,
  page,
  pageIndex,
  imageUrls,
  scale,
  interactive,
  className,
}: {
  doc: DesignDoc;
  page: DesignPage;
  pageIndex: number;
  imageUrls: Record<string, string>;
  scale: number;
  interactive: boolean;
  className?: string;
}) {
  const { width: W, height: H } = doc.canvas;
  const selection = useDesign((s) => s.selection);
  const editingId = useDesign((s) => s.editingElementId);
  const select = useDesign((s) => s.select);
  const setEditing = useDesign((s) => s.setEditing);
  const apply = useDesign((s) => s.apply);
  const selectedId = interactive && selection.pageIndex === pageIndex ? selection.elementId : null;

  /** Pointer drag mapped to canvas px. */
  const startDrag = (
    e: ReactPointerEvent,
    onMove: (dx: number, dy: number, shift: boolean) => (d: DesignDoc) => DesignDoc,
    key: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const k = `${key}:${e.timeStamp}`;
    const move = (ev: PointerEvent) => apply(onMove((ev.clientX - sx) / scale, (ev.clientY - sy) / scale, ev.shiftKey), k);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onElementDown = (e: ReactPointerEvent, el: DesignElement) => {
    if (!interactive || el.locked) return;
    if (editingId === el.id) return; // typing inside it
    select({ pageIndex, elementId: el.id });
    const start = { x: el.x, y: el.y };
    startDrag(
      e,
      (dx, dy, shift) =>
        commands.patchElement(pageIndex, el.id, (cur) => ({
          ...cur,
          x: Math.round(shift ? start.x : start.x + dx),
          y: Math.round(start.y + dy),
        })),
      `move-${el.id}`,
    );
  };

  const onHandleDown = (e: ReactPointerEvent, el: DesignElement, handle: Handle) => {
    const start = { x: el.x, y: el.y, w: el.w, h: el.h };
    startDrag(
      e,
      (dx, dy) =>
        commands.patchElement(pageIndex, el.id, (cur) => {
          let { x, y, w, h } = start;
          if (handle.includes("e")) w = Math.max(20, start.w + dx);
          if (handle.includes("s")) h = Math.max(20, start.h + dy);
          if (handle.includes("w")) {
            w = Math.max(20, start.w - dx);
            x = start.x + (start.w - w);
          }
          if (handle.includes("n")) {
            h = Math.max(20, start.h - dy);
            y = start.y + (start.h - h);
          }
          return { ...cur, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
        }),
      `resize-${el.id}`,
    );
  };

  return (
    <div
      className={cn("relative shrink-0 overflow-hidden bg-black", className)}
      style={{ width: W * scale, height: H * scale }}
      onPointerDown={() => interactive && select({ pageIndex, elementId: null })}
    >
      <style dangerouslySetInnerHTML={{ __html: fontFaceCss() }} />
      <div
        className="absolute left-0 top-0 origin-top-left select-none"
        style={{ width: W, height: H, transform: `scale(${scale})`, background: page.background }}
      >
        {page.elements.map((el) => (
          <ElementView
            key={el.id}
            el={el}
            imageUrl={imageUrls[el.id]}
            selected={selectedId === el.id}
            editing={interactive && editingId === el.id}
            interactive={interactive}
            onPointerDown={(e) => onElementDown(e, el)}
            onDoubleClick={() => interactive && el.type === "text" && !el.locked && setEditing(el.id)}
            onCommitText={(spans) => {
              apply(commands.patchElement<DesignTextElement>(pageIndex, el.id, (cur) => ({ ...cur, spans })));
              setEditing(null);
            }}
          />
        ))}
        {selectedId &&
          (() => {
            const el = page.elements.find((x) => x.id === selectedId);
            if (!el || el.locked) return null;
            return (
              <>
                <div
                  className="pointer-events-none absolute border-2 border-sky-500"
                  style={{ left: el.x - 2, top: el.y - 2, width: el.w + 4, height: el.h + 4 }}
                />
                {HANDLES.map((h) => (
                  <div
                    key={h}
                    onPointerDown={(e) => onHandleDown(e, el, h)}
                    className="absolute size-5 rounded-full border-2 border-sky-500 bg-white"
                    style={{
                      left: el.x + (h.includes("w") ? 0 : h.includes("e") ? el.w : el.w / 2) - 10,
                      top: el.y + (h.includes("n") ? 0 : h.includes("s") ? el.h : el.h / 2) - 10,
                      cursor: `${h}-resize`,
                    }}
                  />
                ))}
              </>
            );
          })()}
      </div>
    </div>
  );
}

function ElementView({
  el,
  imageUrl,
  selected,
  editing,
  interactive,
  onPointerDown,
  onDoubleClick,
  onCommitText,
}: {
  el: DesignElement;
  imageUrl: string | undefined;
  selected: boolean;
  editing: boolean;
  interactive: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onDoubleClick: () => void;
  onCommitText: (spans: DesignSpan[]) => void;
}) {
  const base: React.CSSProperties = {
    position: "absolute",
    left: el.x,
    top: el.y,
    width: el.w,
    height: el.h,
    opacity: el.opacity,
    cursor: interactive && !el.locked ? "move" : "default",
  };
  const hover = interactive && !selected && !el.locked ? "hover:outline hover:outline-[3px] hover:outline-sky-300/70" : "";

  if (el.type === "rect") {
    return (
      <div
        className={hover}
        onPointerDown={onPointerDown}
        style={{
          ...base,
          borderRadius: el.radius,
          ...(el.gradientTo
            ? { backgroundImage: `linear-gradient(180deg, ${rgba(el.fill)} 0%, ${rgba(el.gradientTo)} 100%)` }
            : { backgroundColor: rgba(el.fill) }),
        }}
      />
    );
  }
  if (el.type === "image") {
    return (
      <div className={hover} onPointerDown={onPointerDown} style={{ ...base, borderRadius: el.radius, overflow: "hidden" }}>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- canvas-px sized, drawn to match the exporter
          <img src={imageUrl} alt="" draggable={false} className="pointer-events-none h-full w-full" style={{ objectFit: el.fit }} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted text-[28px] text-muted-foreground">image</div>
        )}
      </div>
    );
  }
  return (
    <TextView el={el} base={base} hover={hover} editing={editing} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} onCommitText={onCommitText} />
  );
}

function TextView({
  el,
  base,
  hover,
  editing,
  onPointerDown,
  onDoubleClick,
  onCommitText,
}: {
  el: DesignTextElement;
  base: React.CSSProperties;
  hover: string;
  editing: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onDoubleClick: () => void;
  onCommitText: (spans: DesignSpan[]) => void;
}) {
  const layout = useMemo(() => layoutDesignText(el), [el]);
  const font = FONTS[el.style.fontId];
  const shadow = el.style.shadow
    ? `${el.style.shadow.x}px ${el.style.shadow.y}px ${el.style.shadow.blur}px ${rgba({ color: el.style.shadow.color, alpha: el.style.shadow.alpha })}`
    : undefined;

  if (editing) return <TextEditor el={el} onCommit={onCommitText} />;

  return (
    <div className={hover} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} style={base}>
      {layout.lines.map((line, i) => (
        <div
          key={i}
          className="absolute flex whitespace-pre"
          style={{
            left: line.x - el.x,
            top: line.y - el.y,
            height: layout.linePitchPx,
            lineHeight: `${layout.linePitchPx}px`,
            fontSize: layout.fontSizePx,
            fontFamily: `"${font.cssFamily}"`,
            fontWeight: font.cssWeight,
            color: el.style.color,
            ...(shadow ? { textShadow: shadow } : {}),
          }}
        >
          {line.words.map((w, wi) => (
            <span key={wi} style={w.color ? { color: w.color } : undefined}>
              {(wi > 0 ? " " : "") + w.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Inline editing: a textarea in the element's box and font. Highlights
 * survive an edit — the coloured phrases are re-applied to the new text —
 * and the toolbar colours the current textarea selection.
 */
function TextEditor({ el, onCommit }: { el: DesignTextElement; onCommit: (spans: DesignSpan[]) => void }) {
  const font = FONTS[el.style.fontId];
  const initial = el.spans.map((s) => s.text).join("");
  const [text, setText] = useState(initial);
  const [colored, setColored] = useState<Array<{ phrase: string; color: string }>>(
    el.spans.filter((s) => s.color).map((s) => ({ phrase: s.text, color: s.color! })),
  );
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => onCommit(rehighlight(text, colored));
  const paint = (color: string | null) => {
    const ta = ref.current;
    if (!ta) return;
    const sel = text.slice(ta.selectionStart, ta.selectionEnd).trim();
    if (!sel) return;
    setColored((prev) => {
      const rest = prev.filter((c) => c.phrase.toLowerCase() !== sel.toLowerCase());
      return color ? [...rest, { phrase: sel, color }] : rest;
    });
    ta.focus();
  };

  return (
    <div style={{ position: "absolute", left: el.x, top: el.y, width: el.w, height: el.h }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCommit(el.spans);
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
        }}
        className="h-full w-full resize-none bg-white/10 outline outline-[4px] outline-sky-500"
        style={{
          fontFamily: `"${font.cssFamily}"`,
          fontWeight: font.cssWeight,
          fontSize: el.style.sizePx,
          lineHeight: el.style.lineHeight,
          color: el.style.color,
          textAlign: el.style.align,
          textTransform: el.style.uppercase ? "uppercase" : "none",
        }}
      />
      <div
        className="absolute -top-16 left-0 flex items-center gap-2 rounded-lg bg-popover p-2 text-[20px] shadow-lg"
        onMouseDown={(e) => e.preventDefault()}
      >
        <span className="text-muted-foreground">Select words, then:</span>
        {[
          ["#FF3B3B", "Red"],
          ["#22E07A", "Green"],
          ["#FFE14D", "Yellow"],
        ].map(([c, label]) => (
          <button key={c} type="button" onClick={() => paint(c)} className="rounded px-3 py-1 font-semibold text-black" style={{ background: c }}>
            {label}
          </button>
        ))}
        <button type="button" onClick={() => paint(null)} className="rounded border border-border px-3 py-1">
          Plain
        </button>
        <button type="button" onClick={commit} className="rounded bg-foreground px-3 py-1 font-semibold text-background">
          Done
        </button>
      </div>
    </div>
  );
}

/** Split `text` into spans so each coloured phrase keeps its colour. */
export function rehighlight(text: string, colored: Array<{ phrase: string; color: string }>): DesignSpan[] {
  const marks: Array<{ start: number; end: number; color: string }> = [];
  const lower = text.toLowerCase();
  for (const c of colored) {
    const p = c.phrase.trim().toLowerCase();
    if (!p) continue;
    let from = 0;
    while (from <= lower.length) {
      const start = lower.indexOf(p, from);
      if (start < 0) break;
      const end = start + p.length;
      if (!marks.some((m) => start < m.end && end > m.start)) marks.push({ start, end, color: c.color });
      from = end;
    }
  }
  marks.sort((a, b) => a.start - b.start);
  const spans: DesignSpan[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) spans.push({ text: text.slice(cursor, m.start) });
    spans.push({ text: text.slice(m.start, m.end), color: m.color });
    cursor = m.end;
  }
  if (cursor < text.length || spans.length === 0) spans.push({ text: text.slice(cursor) });
  return spans;
}
