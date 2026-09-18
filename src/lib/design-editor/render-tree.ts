/**
 * DesignPage → satori element tree. Server-only consumer of the same layout
 * the stage draws; the stage's React markup mirrors this node for node.
 *
 * Images are passed in already resolved to URLs satori can fetch or data
 * URLs (the render task does that — this module stays pure).
 */
import { FONTS } from "@/lib/clip-editor/fonts";
import type { DesignElement, DesignPage, DesignTextElement, Rgba } from "./doc";
import { layoutDesignText } from "./layout";

type Node = { type: string; props: Record<string, unknown> };

export type ResolvedImages = Record<string, string>; // element id → src

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

function elementNodes(el: DesignElement, images: ResolvedImages): Node[] {
  if (el.type === "text") return textNodes(el);
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
  const src = images[el.id];
  if (!src) return [];
  return [
    {
      type: "img",
      props: {
        src,
        style: {
          position: "absolute",
          left: el.x,
          top: el.y,
          width: el.w,
          height: el.h,
          objectFit: el.fit,
          borderRadius: el.radius,
          opacity: el.opacity,
        },
      },
    },
  ];
}

export function pageToSatoriTree(
  page: DesignPage,
  canvas: { width: number; height: number },
  images: ResolvedImages,
): Node {
  return {
    type: "div",
    props: {
      style: {
        position: "relative",
        display: "flex",
        width: canvas.width,
        height: canvas.height,
        backgroundColor: page.background,
        overflow: "hidden",
      },
      children: page.elements.flatMap((el) => elementNodes(el, images)),
    },
  };
}

/** The fonts a page needs, for satori's `fonts` option. */
export function fontsUsed(page: DesignPage): Array<(typeof FONTS)[keyof typeof FONTS]> {
  const ids = new Set(
    page.elements.flatMap((el) => (el.type === "text" ? [el.style.fontId] : [])),
  );
  return [...ids].map((id) => FONTS[id]);
}
