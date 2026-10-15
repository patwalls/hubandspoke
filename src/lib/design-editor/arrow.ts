/**
 * Arrows — the pure half, shared by the stage, the exporter and the cover
 * style reader.
 *
 * An arrow is an ordinary box + rotation like every other element, so move,
 * snap, layers, undo and canvas resize all just work: the shaft runs along
 * the box's horizontal centre line from the left edge (tail) to the right
 * edge (head), the box turns about its centre by `rotation`, and `bend`
 * curves the shaft (a quadratic curve whose midpoint sits `bend · length`
 * off the straight line — positive bulges to the LEFT of the direction of
 * travel). The box height is only hit/selection room, kept just big enough
 * for the bulge (`arrowBoxHeight`).
 *
 * The editor edits arrows by their ends (drag the tail or head, drag the
 * middle to bend): `arrowEnds` / `arrowFromEnds` / `bendFromPoint` convert
 * between that and the box. Both renderers draw `arrowSvg` — the stage
 * inline, satori as a data-URL <img> — so the export matches the editor.
 */
import type { DesignArrowElement } from "./doc";

export interface Point {
  x: number;
  y: number;
}

/** Arrowhead length for a stroke: chunky enough to read on a phone, never
 *  more than 40% of the arrow. */
export function arrowHeadLength(thickness: number, length: number): number {
  return Math.min(Math.max(thickness * 3.4, 22), Math.max(8, length * 0.4));
}

/** Room around the box the stroke and heads can spill into. */
export function arrowMargin(el: Pick<DesignArrowElement, "thickness" | "w">): number {
  return Math.ceil(arrowHeadLength(el.thickness, el.w) + el.thickness * 2);
}

/** Box height that holds the bulge of a bend (the curve's furthest point is
 *  `bend · length` off the chord) plus the head, centred on the chord. */
export function arrowBoxHeight(length: number, bend: number, thickness: number): number {
  return Math.max(Math.round(2 * Math.abs(bend) * length + 2 * Math.max(arrowHeadLength(thickness, length) * 0.6, thickness * 2)), 24);
}

/** Tail and head on the canvas. */
export function arrowEnds(el: Pick<DesignArrowElement, "x" | "y" | "w" | "h" | "rotation">): { tail: Point; head: Point } {
  const t = ((el.rotation ?? 0) * Math.PI) / 180;
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const dx = (Math.cos(t) * el.w) / 2;
  const dy = (Math.sin(t) * el.w) / 2;
  return { tail: { x: cx - dx, y: cy - dy }, head: { x: cx + dx, y: cy + dy } };
}

/** The curve's midpoint on the canvas — where the bend handle sits. */
export function arrowBendPoint(el: Pick<DesignArrowElement, "x" | "y" | "w" | "h" | "rotation" | "bend">): Point {
  const t = ((el.rotation ?? 0) * Math.PI) / 180;
  const off = el.bend * el.w; // along the local −y (left of travel)
  return { x: el.x + el.w / 2 + Math.sin(t) * off, y: el.y + el.h / 2 - Math.cos(t) * off };
}

/** The box + rotation for an arrow from `tail` to `head`. Rotation is in
 *  (−180, 180]; a zero-length arrow keeps a 1px shaft. */
export function arrowFromEnds(tail: Point, head: Point, bend: number, thickness: number): { x: number; y: number; w: number; h: number; rotation: number | undefined } {
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const w = Math.max(1, Math.hypot(dx, dy));
  const h = arrowBoxHeight(w, bend, thickness);
  const deg = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) * 10) / 10;
  const rotation = deg === -180 ? 180 : deg;
  const cx = (tail.x + head.x) / 2;
  const cy = (tail.y + head.y) / 2;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h, rotation: rotation === 0 ? undefined : rotation };
}

/** The bend that puts the curve's midpoint at (or level with) `p`, clamped. */
export function bendFromPoint(el: Pick<DesignArrowElement, "x" | "y" | "w" | "h" | "rotation">, p: Point): number {
  const t = ((el.rotation ?? 0) * Math.PI) / 180;
  const vx = p.x - (el.x + el.w / 2);
  const vy = p.y - (el.y + el.h / 2);
  // Distance along the left-of-travel normal (sin t, −cos t).
  const off = vx * Math.sin(t) - vy * Math.cos(t);
  const bend = off / Math.max(1, el.w);
  return Math.round(Math.max(-0.5, Math.min(0.5, bend)) * 1000) / 1000;
}

/** Snap a head position so the shaft's angle is a multiple of `stepDeg`
 *  (shift-drag), keeping its length. */
export function snapAngle(tail: Point, head: Point, stepDeg = 15): Point {
  const len = Math.hypot(head.x - tail.x, head.y - tail.y);
  const step = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(head.y - tail.y, head.x - tail.x) / step) * step;
  return { x: tail.x + Math.cos(a) * len, y: tail.y + Math.sin(a) * len };
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * The arrow as a standalone SVG, `w + 2m` × `h + 2m` with the box at (m, m)
 * (m = `arrowMargin`) so heads and round caps never clip. Unrotated — the
 * caller turns its wrapper about the box centre. `centerline` is the shaft
 * in the same coordinates (the editor's click target).
 */
export function arrowSvg(el: Pick<DesignArrowElement, "w" | "h" | "bend" | "color" | "thickness" | "startHead" | "endHead">): { svg: string; margin: number; width: number; height: number; centerline: string } {
  const m = arrowMargin(el);
  const len = el.w;
  const cy = m + el.h / 2;
  const p0 = { x: m, y: cy };
  const p2 = { x: m + len, y: cy };
  // Quadratic: the midpoint is (p0 + 2c + p2) / 4, so the control point sits
  // twice the bulge off the chord.
  const c = { x: m + len / 2, y: cy - 2 * el.bend * len };
  const headLen = arrowHeadLength(el.thickness, len);
  const spread = (28 * Math.PI) / 180;
  const parts: string[] = [];
  let start = p0;
  let end = p2;

  const head = (tip: Point, from: Point, style: DesignArrowElement["endHead"]): Point => {
    if (style === "none") return tip;
    let ux = tip.x - from.x;
    let uy = tip.y - from.y;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;
    const wing = (sign: number) => {
      const a = Math.atan2(uy, ux) + Math.PI + sign * spread;
      return { x: tip.x + Math.cos(a) * headLen, y: tip.y + Math.sin(a) * headLen };
    };
    const l = wing(1);
    const r = wing(-1);
    if (style === "filled") {
      parts.push(`<path d="M${fmt(l.x)} ${fmt(l.y)} L${fmt(tip.x)} ${fmt(tip.y)} L${fmt(r.x)} ${fmt(r.y)} Z" fill="${el.color}" stroke="${el.color}" stroke-width="${fmt(el.thickness * 0.5)}" stroke-linejoin="round"/>`);
      // Stop the shaft inside the triangle so its round cap can't poke out.
      return { x: tip.x - ux * headLen * 0.7, y: tip.y - uy * headLen * 0.7 };
    }
    parts.push(`<path d="M${fmt(l.x)} ${fmt(l.y)} L${fmt(tip.x)} ${fmt(tip.y)} L${fmt(r.x)} ${fmt(r.y)}" fill="none" stroke="${el.color}" stroke-width="${fmt(el.thickness)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    return tip;
  };

  end = head(p2, c, el.endHead);
  start = head(p0, c, el.startHead);
  const shaft = el.bend === 0 ? `M${fmt(start.x)} ${fmt(start.y)} L${fmt(end.x)} ${fmt(end.y)}` : `M${fmt(start.x)} ${fmt(start.y)} Q${fmt(c.x)} ${fmt(c.y)} ${fmt(end.x)} ${fmt(end.y)}`;
  parts.unshift(`<path d="${shaft}" fill="none" stroke="${el.color}" stroke-width="${fmt(el.thickness)}" stroke-linecap="round"/>`);
  const W = len + 2 * m;
  const H = el.h + 2 * m;
  // The full tail→head curve, for the editor's (invisible, fat) hit target.
  const centerline = el.bend === 0 ? `M${fmt(p0.x)} ${fmt(p0.y)} L${fmt(p2.x)} ${fmt(p2.y)}` : `M${fmt(p0.x)} ${fmt(p0.y)} Q${fmt(c.x)} ${fmt(c.y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
  return { width: W, height: H, centerline, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W)}" height="${fmt(H)}" viewBox="0 0 ${fmt(W)} ${fmt(H)}">${parts.join("")}</svg>`, margin: m };
}
