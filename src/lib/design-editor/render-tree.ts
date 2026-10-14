/**
 * DesignPage → satori element tree. Server-only consumer of the same layout
 * the stage draws; the stage's React markup mirrors this node for node.
 *
 * Images are passed in already resolved to URLs satori can fetch or data
 * URLs (the render task does that — this module stays pure).
 */
import { FONTS } from "@/lib/clip-editor/fonts";
import type { DesignElement, DesignPage, DesignStatCardElement, DesignTextElement, Rgba } from "./doc";
import { coverGeometry, layoutDesignText } from "./layout";
import { layoutChannel, type ChannelInfo } from "./channel";
import { layoutStatCard, sparklineSvg, svgDataUrl } from "./stat-card";

type Node = { type: string; props: Record<string, unknown> };

/** Element id → the picture, with its pixel size (the crop needs it). For a
 *  channel element, its avatar under the same id. */
export type ResolvedImages = Record<string, { src: string; width: number; height: number }>;
/** Channel element id → the account it shows. */
export type ResolvedChannels = Record<string, ChannelInfo | null>;

function rgba(c: Rgba): string {
  const r = parseInt(c.color.slice(1, 3), 16);
  const g = parseInt(c.color.slice(3, 5), 16);
  const b = parseInt(c.color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${c.alpha})`;
}

/** `transform: rotate()` for a tilted element's outer box — the stage's
 *  div gets the same string, so both turn about the box centre. */
function rotation(el: { rotation?: number }): Record<string, string> {
  return el.rotation ? { transform: `rotate(${el.rotation}deg)`, transformOrigin: "center" } : {};
}

/** The lines of a text element. With `origin`, positioned relative to it
 *  (for lines inside a wrapper div) instead of in canvas coordinates. */
function textNodes(el: DesignTextElement, origin: { x: number; y: number } = { x: 0, y: 0 }): Node[] {
  const layout = layoutDesignText(el);
  const font = FONTS[el.style.fontId];
  const shadow = el.style.shadow
    ? `${el.style.shadow.x}px ${el.style.shadow.y}px ${el.style.shadow.blur}px ${rgba({ color: el.style.shadow.color, alpha: el.style.shadow.alpha })}`
    : undefined;
  return layout.lines.map((line, i) => ({
    type: "div",
    props: {
      key: `${el.id}-${i}`,
      style: {
        position: "absolute",
        left: line.x - origin.x,
        top: line.y - origin.y,
        height: layout.linePitchPx,
        lineHeight: `${layout.linePitchPx}px`,
        fontSize: layout.fontSizePx,
        fontFamily: font.cssFamily,
        fontWeight: font.cssWeight,
        color: el.style.color,
        whiteSpace: "pre",
        display: "flex",
        opacity: el.opacity,
        ...(el.style.letterSpacing ? { letterSpacing: `${el.style.letterSpacing}em` } : {}),
        ...(shadow ? { textShadow: shadow } : {}),
      },
      children: line.words.map((w, wi) => ({
        type: "span",
        props: {
          key: wi,
          style: w.color ? { color: w.color } : {},
          children: (wi > 0 ? " " : "") + w.text,
        },
      })),
    },
  }));
}

/** Channel row: one wrapper div at the element's box (so a tilt rotates the
 *  whole row), avatar and text positioned inside it. */
function channelNodes(el: DesignElement & { type: "channel" }, images: ResolvedImages, channels: ResolvedChannels): Node[] {
  const info = channels[el.id] ?? null;
  const l = layoutChannel(el, info);
  const avatar = images[el.id];
  const origin = { x: el.x, y: el.y };
  const nodes: Node[] = [];
  if (avatar) {
    const g = coverGeometry({ width: avatar.width, height: avatar.height }, { w: l.avatar.d, h: l.avatar.d }, { x: 0.5, y: 0.5, zoom: 1 });
    nodes.push({
      type: "div",
      props: {
        style: { position: "absolute", left: l.avatar.x - origin.x, top: l.avatar.y - origin.y, width: l.avatar.d, height: l.avatar.d, borderRadius: l.avatar.d / 2, overflow: "hidden", display: "flex" },
        children: { type: "img", props: { src: avatar.src, width: g.width, height: g.height, style: { position: "absolute", left: g.left, top: g.top, width: g.width, height: g.height } } },
      },
    });
  } else {
    nodes.push({
      type: "div",
      props: {
        style: { position: "absolute", left: l.avatar.x - origin.x, top: l.avatar.y - origin.y, width: l.avatar.d, height: l.avatar.d, borderRadius: l.avatar.d / 2, backgroundColor: el.theme === "light" ? "#111111" : "#FFFFFF", color: el.theme === "light" ? "#FFFFFF" : "#111111", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONTS.anton.cssFamily, fontSize: Math.round(l.avatar.d * 0.58) },
        children: l.initial,
      },
    });
  }
  nodes.push(...textNodes(l.name, origin));
  if (l.followers) nodes.push(...textNodes(l.followers, origin));
  return [{ type: "div", props: { style: { position: "absolute", left: el.x, top: el.y, width: el.w, height: el.h, display: "flex", opacity: el.opacity, ...rotation(el) }, children: nodes } }];
}

/** Stat card: the card div (fill, border, radius, shadow, tilt) with its
 *  label / value / sub laid out inside and the chart as an SVG image —
 *  the same bytes the stage's <img> shows. */
function statCardNodes(el: DesignStatCardElement): Node[] {
  const l = layoutStatCard(el);
  const children: Node[] = [...textNodes(l.label), ...textNodes(l.value), ...(l.sub ? textNodes(l.sub) : [])];
  if (l.chart) {
    children.push({ type: "img", props: { src: svgDataUrl(sparklineSvg(el, l.chart.w, l.chart.h)), width: l.chart.w, height: l.chart.h, style: { position: "absolute", left: l.chart.x, top: l.chart.y, width: l.chart.w, height: l.chart.h } } });
  }
  return [{
    type: "div",
    props: {
      style: {
        position: "absolute", left: el.x, top: el.y, width: el.w, height: el.h, display: "flex", overflow: "hidden",
        backgroundColor: l.bg, border: `2px solid ${l.border}`, borderRadius: el.radius, opacity: el.opacity,
        ...(el.shadow ? { boxShadow: "0 30px 60px rgba(0,0,0,0.55)" } : {}),
        ...rotation(el),
      },
      children,
    },
  }];
}

function elementNodes(el: DesignElement, images: ResolvedImages, channels: ResolvedChannels): Node[] {
  if (el.type === "text") {
    if (!el.rotation) return textNodes(el);
    // Tilted text: the lines go inside a wrapper at the box so they turn
    // together about its centre.
    return [{ type: "div", props: { style: { position: "absolute", left: el.x, top: el.y, width: el.w, height: el.h, display: "flex", ...rotation(el) }, children: textNodes(el, { x: el.x, y: el.y }) } }];
  }
  if (el.type === "channel") return channelNodes(el, images, channels);
  if (el.type === "statCard") return statCardNodes(el);
  if (el.type === "rect") {
    return [
      {
        type: "div",
        props: {
          style: {
            position: "absolute",
            left: el.x,
            top: el.y,
            width: el.w,
            height: el.h,
            borderRadius: el.radius,
            opacity: el.opacity,
            ...rotation(el),
            ...(el.gradientTo
              ? { backgroundImage: `linear-gradient(${el.gradientDirection === "up" ? 0 : 180}deg, ${rgba(el.fill)} 0%, ${rgba(el.gradientTo)} 100%)` }
              : { backgroundColor: rgba(el.fill) }),
          },
        },
      },
    ];
  }
  // Video and captions are drawn by ffmpeg (see design-ffmpeg.ts); the
  // satori pass only bakes what sits under and over them.
  if (el.type !== "image") return [];
  const img = images[el.id];
  if (!img) return [];
  // Same trick as the stage: a clipping box with the picture positioned
  // inside it by coverGeometry — satori has no object-position.
  const g = coverGeometry({ width: img.width, height: img.height }, { w: el.w, h: el.h }, el.crop, el.fit);
  return [
    {
      type: "div",
      props: {
        style: {
          position: "absolute",
          left: el.x,
          top: el.y,
          width: el.w,
          height: el.h,
          borderRadius: el.radius,
          opacity: el.opacity,
          overflow: "hidden",
          display: "flex",
          ...rotation(el),
        },
        children: {
          type: "img",
          props: {
            src: img.src,
            width: g.width,
            height: g.height,
            style: { position: "absolute", left: g.left, top: g.top, width: g.width, height: g.height },
          },
        },
      },
    },
  ];
}

export function pageToSatoriTree(
  page: DesignPage,
  canvas: { width: number; height: number },
  images: ResolvedImages,
  opts: { transparent?: boolean; channels?: ResolvedChannels } = {},
): Node {
  const channels = opts.channels ?? {};
  return {
    type: "div",
    props: {
      style: {
        position: "relative",
        display: "flex",
        width: canvas.width,
        height: canvas.height,
        ...(opts.transparent ? {} : { backgroundColor: page.background }),
        overflow: "hidden",
      },
      children: page.elements.flatMap((el) => elementNodes(el, images, channels)),
    },
  };
}

/**
 * A video slide is baked as two stills around the footage: everything below
 * the video element in z-order (on the page background) and everything above
 * it (transparent). ffmpeg stacks under → video → over → captions.
 */
export function videoPageLayers(page: DesignPage): { under: DesignPage; over: DesignPage } {
  const vi = page.elements.findIndex((el) => el.type === "video");
  const idx = vi < 0 ? page.elements.length : vi;
  return {
    under: { ...page, elements: page.elements.slice(0, idx) },
    over: { ...page, elements: page.elements.slice(idx + 1) },
  };
}

/** The fonts a page needs, for satori's `fonts` option. */
export function fontsUsed(page: DesignPage): Array<(typeof FONTS)[keyof typeof FONTS]> {
  const ids = new Set(
    page.elements.flatMap((el) => (el.type === "text" || el.type === "captions" ? [el.style.fontId] : el.type === "channel" ? (["inter-semibold", "inter-regular", "anton"] as const) : el.type === "statCard" ? (["inter-semibold", "inter-bold", "inter-regular"] as const) : [])),
  );
  return [...ids].map((id) => FONTS[id]);
}
