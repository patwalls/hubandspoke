/**
 * Snapping, the Canva way: while something is dragged or resized, its edges
 * and centre lines pull onto the canvas centre, the canvas edges and other
 * elements' edges/centres when they come within a few screen pixels, and a
 * guide shows what it snapped to. Pure; both editors call these.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapGuide {
  axis: "x" | "y";
  /** Canvas px of the guide line. */
  at: number;
  kind: "center" | "edge" | "element" | "third" | "video";
}

export interface SnapTarget {
  at: number;
  kind: SnapGuide["kind"];
}

export interface SnapTargets {
  x: SnapTarget[];
  y: SnapTarget[];
}

/** Canvas centre + edges, and every other element's edges and centres. */
export function elementSnapTargets(others: Rect[], canvas: { width: number; height: number }, opts: { margin?: number } = {}): SnapTargets {
  const m = opts.margin ?? 0;
  const x: SnapTarget[] = [
    { at: 0, kind: "edge" },
    { at: canvas.width, kind: "edge" },
    { at: canvas.width / 2, kind: "center" },
    ...(m > 0 ? [{ at: m, kind: "edge" as const }, { at: canvas.width - m, kind: "edge" as const }] : []),
  ];
  const y: SnapTarget[] = [
    { at: 0, kind: "edge" },
    { at: canvas.height, kind: "edge" },
    { at: canvas.height / 2, kind: "center" },
    ...(m > 0 ? [{ at: m, kind: "edge" as const }, { at: canvas.height - m, kind: "edge" as const }] : []),
  ];
  for (const o of others) {
    x.push({ at: o.x, kind: "element" }, { at: o.x + o.w / 2, kind: "element" }, { at: o.x + o.w, kind: "element" });
    y.push({ at: o.y, kind: "element" }, { at: o.y + o.h / 2, kind: "element" }, { at: o.y + o.h, kind: "element" });
  }
  return { x, y };
}

/** The closest (candidate, target) pair within `threshold`, as the delta to
 *  add to the candidates. Prefers centre/edge targets on a tie. */
function bestDelta(candidates: number[], targets: SnapTarget[], threshold: number): { delta: number; target: SnapTarget } | null {
  let best: { delta: number; target: SnapTarget; dist: number } | null = null;
  for (const c of candidates) {
    for (const t of targets) {
      const dist = Math.abs(t.at - c);
      if (dist > threshold) continue;
      if (!best || dist < best.dist - 1e-6 || (Math.abs(dist - best.dist) < 1e-6 && t.kind !== "element" && best.target.kind === "element")) {
        best = { delta: t.at - c, target: t, dist };
      }
    }
  }
  return best ? { delta: best.delta, target: best.target } : null;
}

/** Snap a rectangle being MOVED: its left/centre/right and top/middle/bottom
 *  pull onto the targets. Returns the snapped position and the guides. */
export function snapMove(rect: Rect, targets: SnapTargets, threshold: number): { x: number; y: number; guides: SnapGuide[] } {
  const guides: SnapGuide[] = [];
  let { x, y } = rect;
  const sx = bestDelta([rect.x, rect.x + rect.w / 2, rect.x + rect.w], targets.x, threshold);
  if (sx) {
    x = rect.x + sx.delta;
    guides.push({ axis: "x", at: sx.target.at, kind: sx.target.kind });
  }
  const sy = bestDelta([rect.y, rect.y + rect.h / 2, rect.y + rect.h], targets.y, threshold);
  if (sy) {
    y = rect.y + sy.delta;
    guides.push({ axis: "y", at: sy.target.at, kind: sy.target.kind });
  }
  return { x, y, guides };
}

/** Snap a rectangle being RESIZED by `handle` (nw, n, ne, e, se, s, sw, w):
 *  only the moving edges pull. */
export function snapResize(rect: Rect, handle: string, targets: SnapTargets, threshold: number, minSize = 20): { rect: Rect; guides: SnapGuide[] } {
  const guides: SnapGuide[] = [];
  let { x, y, w, h } = rect;
  if (handle.includes("e")) {
    const s = bestDelta([x + w], targets.x, threshold);
    if (s) {
      w = Math.max(minSize, w + s.delta);
      guides.push({ axis: "x", at: s.target.at, kind: s.target.kind });
    }
  } else if (handle.includes("w")) {
    const s = bestDelta([x], targets.x, threshold);
    if (s && w - s.delta >= minSize) {
      x += s.delta;
      w -= s.delta;
      guides.push({ axis: "x", at: s.target.at, kind: s.target.kind });
    }
  }
  if (handle.includes("s")) {
    const s = bestDelta([y + h], targets.y, threshold);
    if (s) {
      h = Math.max(minSize, h + s.delta);
      guides.push({ axis: "y", at: s.target.at, kind: s.target.kind });
    }
  } else if (handle.includes("n")) {
    const s = bestDelta([y], targets.y, threshold);
    if (s && h - s.delta >= minSize) {
      y += s.delta;
      h -= s.delta;
      guides.push({ axis: "y", at: s.target.at, kind: s.target.kind });
    }
  }
  return { rect: { x, y, w, h }, guides };
}

/** Snap a single coordinate (the clip editor's vertical-only drags). */
export function snapValue(value: number, targets: SnapTarget[], threshold: number): { value: number; guide: SnapGuide | null; axis?: never } {
  const s = bestDelta([value], targets, threshold);
  return s ? { value: value + s.delta, guide: { axis: "y", at: s.target.at, kind: s.target.kind } } : { value, guide: null };
}

/** A snap distance in canvas px that feels like ~7 screen px at any zoom. */
export function snapThreshold(scale: number): number {
  return 7 / Math.max(scale, 0.05);
}

// ── The shared on/off switch (both editors, per browser) ────────────────────

const SNAP_KEY = "hs:editor:snap";

export function readSnapEnabled(): boolean {
  try {
    return window.localStorage.getItem(SNAP_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSnapEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(SNAP_KEY, on ? "on" : "off");
  } catch {
    /* fine */
  }
}
