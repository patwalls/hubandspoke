/**
 * DesignPage → satori element tree. Server-only consumer of the same layout
 * the stage draws; the stage's React markup mirrors this node for node.
 *
 * Images are passed in already resolved to URLs satori can fetch or data
 * URLs (the render task does that — this module stays pure).
 */
import { FONTS } from "@/lib/clip-editor/fonts";
import type { DesignElement, DesignPage, DesignTextElement, Rgba } from "./doc";
import { coverGeometry, layoutDesignText } from "./layout";
import { layoutChannel, type ChannelInfo } from "./channel";

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

function textNodes(el: DesignTextElement): Node[] {
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
        left: line.x,
        top: line.y,
        height: layout.linePitchPx,
        lineHeight: `${layout.linePitchPx}px`,
        fontSize: layout.fontSizePx,
        fontFamily: font.cssFamily,
        fontWeight: font.cssWeight,
        color: el.style.color,
        whiteSpace: "pre",
        display: "flex",
        opacity: el.opacity,
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

function channelNodes(el: DesignElement & { type: "channel" }, images: ResolvedImages, channels: ResolvedChannels): Node[] {
  const info = channels[el.id] ?? null;
  const l = layoutChannel(el, info);
  const avatar = images[el.id];
  const nodes: Node[] = [];
  if (avatar) {
    const g = coverGeometry({ width: avatar.width, height: avatar.height }, { w: l.avatar.d, h: l.avatar.d }, { x: 0.5, y: 0.5, zoom: 1 });
    nodes.push({
      type: "div",
      props: {
        style: { position: "absolute", left: l.avatar.x, top: l.avatar.y, width: l.avatar.d, height: l.avatar.d, borderRadius: l.avatar.d / 2, overflow: "hidden", display: "flex", opacity: el.opacity },
        children: { type: "img", props: { src: avatar.src, width: g.width, height: g.height, style: { position: "absolute", left: g.left, top: g.top, width: g.width, height: g.height } } },
      },
    });
  } else {
    nodes.push({
      type: "div",
      props: {
        style: { position: "absolute", left: l.avatar.x, top: l.avatar.y, width: l.avatar.d, height: l.avatar.d, borderRadius: l.avatar.d / 2, backgroundColor: el.theme === "light" ? "#111111" : "#FFFFFF", color: el.theme === "light" ? "#FFFFFF" : "#111111", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONTS.anton.cssFamily, fontSize: Math.round(l.avatar.d * 0.58), opacity: el.opacity },
        children: l.initial,
      },
    });
  }
  nodes.push(...textNodes({ ...l.name, opacity: el.opacity }));
  if (l.followers) nodes.push(...textNodes({ ...l.followers, opacity: el.opacity }));
  return nodes;
}

function elementNodes(el: DesignElement, images: ResolvedImages, channels: ResolvedChannels): Node[] {
  if (el.type === "text") return textNodes(el);
  if (el.type === "channel") return channelNodes(el, images, channels);
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
            ...(el.gradientTo
              ? { backgroundImage: `linear-gradient(180deg, ${rgba(el.fill)} 0%, ${rgba(el.gradientTo)} 100%)` }
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
    page.elements.flatMap((el) => (el.type === "text" || el.type === "captions" ? [el.style.fontId] : el.type === "channel" ? (["inter-semibold", "inter-regular", "anton"] as const) : [])),
  );
  return [...ids].map((id) => FONTS[id]);
}
