/**
 * The stat card's geometry, text and chart, shared by the stage and the
 * exporter (like channel.ts for the channel row). Pure.
 *
 * The card is laid out in its OWN coordinates (0,0 = the card's top-left) so
 * both drawers can put it in a rotated wrapper: the stage's div and satori's
 * div both get `transform: rotate(…)` and the children stay relative.
 */
import type { DesignStatCardElement, DesignTextElement } from "./doc";

export interface StatCardLayout {
  bg: string;
  border: string;
  /** Padding, px. */
  pad: number;
  label: DesignTextElement;
  value: DesignTextElement;
  sub: DesignTextElement | null;
  /** The chart's box inside the card, or null when hidden. */
  chart: { x: number; y: number; w: number; h: number } | null;
}

export const STAT_CARD_DARK = { bg: "#161618", border: "#2C2C2E", ink: "#FFFFFF", muted: "#9A9AA0" } as const;
export const STAT_CARD_LIGHT = { bg: "#FFFFFF", border: "#E5E5EA", ink: "#111111", muted: "#6E6E73" } as const;

export function layoutStatCard(el: DesignStatCardElement): StatCardLayout {
  const palette = el.theme === "dark" ? STAT_CARD_DARK : STAT_CARD_LIGHT;
  const pad = Math.round(Math.min(el.w, el.h) * 0.1);
  const textW = Math.max(20, el.w - 2 * pad);
  const labelH = Math.round(el.h * 0.11);
  const valueH = Math.round(el.h * 0.3);
  const subH = Math.round(el.h * 0.1);
  const base = { opacity: 1, locked: false, slot: null, stack: null } as const;
  const style = (sizePx: number, color: string, fontId: DesignTextElement["style"]["fontId"], minSizePx = 10): DesignTextElement["style"] => ({
    fontId, sizePx, lineHeight: 1.1, letterSpacing: 0, color, align: "left", valign: "middle", uppercase: false, shadow: null, autoFit: true, minSizePx,
  });
  const labelY = pad;
  const valueY = labelY + labelH + Math.round(el.h * 0.01);
  const subY = valueY + valueH + Math.round(el.h * 0.01);
  const hasSub = el.sub.trim().length > 0;
  const label: DesignTextElement = { ...base, id: `${el.id}-label`, name: "Label", type: "text", x: pad, y: labelY, w: textW, h: labelH, spans: [{ text: el.label }], style: style(Math.round(el.h * 0.085), palette.muted, "inter-semibold") };
  const value: DesignTextElement = { ...base, id: `${el.id}-value`, name: "Value", type: "text", x: pad, y: valueY, w: textW, h: valueH, spans: [{ text: el.value }], style: style(Math.round(el.h * 0.25), palette.ink, "inter-bold", 14) };
  const sub: DesignTextElement | null = hasSub
    ? { ...base, id: `${el.id}-sub`, name: "Sub", type: "text", x: pad, y: subY, w: textW, h: subH, spans: [{ text: el.sub }], style: style(Math.round(el.h * 0.07), palette.muted, "inter-regular") }
    : null;
  const chartTop = (hasSub ? subY + subH : valueY + valueH) + Math.round(el.h * 0.04);
  const chartH = el.h - chartTop - Math.round(pad * 0.5);
  const chart = el.showChart && chartH > 20 ? { x: Math.round(pad * 0.6), y: chartTop, w: Math.max(20, el.w - Math.round(pad * 1.2)), h: chartH } : null;
  return { bg: palette.bg, border: palette.border, pad, label, value, sub, chart };
}

/** Normalise the series into the box and build the line + filled area paths. */
export function sparklinePaths(series: number[], w: number, h: number): { line: string; area: string } {
  const pts = series.length >= 2 ? series : [0, 1];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const top = h * 0.08;
  const bottom = h * 0.96;
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * w;
    const y = bottom - ((v - min) / span) * (bottom - top);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  return { line, area };
}

/** The chart as a standalone SVG (no text, so no fonts needed): the stage
 *  shows it in an <img>, satori gets the same bytes as a data URL. */
export function sparklineSvg(el: DesignStatCardElement, w: number, h: number): string {
  const { line, area } = sparklinePaths(el.series, w, h);
  const stroke = Math.max(2, Math.round(h * 0.035));
  const id = `g${el.accent.replace("#", "")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${el.accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${el.accent}" stop-opacity="0.02"/></linearGradient></defs><path d="${area}" fill="url(#${id})"/><path d="${line}" fill="none" stroke="${el.accent}" stroke-width="${stroke}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export function svgDataUrl(svg: string): string {
  const b64 = typeof Buffer !== "undefined" ? Buffer.from(svg, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(svg)));
  return `data:image/svg+xml;base64,${b64}`;
}

/** A plausible "up and to the right" chart shape, deterministic for a seed
 *  (the stat's value) so a post renders the same every time. Decoration —
 *  the number is the claim, the curve is not data. */
export function defaultSeries(seed: string, n = 24): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rand = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  let v = 20 + rand() * 10;
  for (let i = 0; i < n; i++) {
    v += 2.2 + (rand() - 0.42) * 14;
    v = Math.max(5, v);
    out.push(Math.round(v * 10) / 10);
  }
  // End on the high: the last point is the peak, with a small dip before it.
  const peak = Math.max(...out) * 1.08;
  out[n - 2] = Math.min(out[n - 2], peak * 0.78);
  out[n - 1] = Math.round(peak * 10) / 10;
  return out;
}
