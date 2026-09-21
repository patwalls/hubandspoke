/**
 * The "TMZ" preset — one 4:5 image, modelled on the format's best posts
 * (Sept 2026): a still of the founder over the top ~55%, a black band
 * below with a three-line first-person quote in condensed all-caps
 * ("MY WEBSITE THAT CONVERTS BANK STATEMENTS MAKES OVER $40,000 EVERY
 * MONTH"), the number in green. Nothing else — the caption carries the
 * story.
 */
import { newElementId, type DesignDoc, type DesignElement, type DesignPage } from "./doc";
import { ai, baseText, photoSlot, text } from "./shared";
import { applyHighlights } from "./template-fill";

export const TMZ_TEMPLATE = "tmz-v1";
export const IG_PORTRAIT = { width: 1080, height: 1350 } as const;

export function buildTmzPage(): DesignPage {
  const { width: W, height: H } = IG_PORTRAIT;
  const photoH = 740;
  const elements: DesignElement[] = [
    photoSlot({ x: 0, y: 0, w: W, h: photoH }),
    text("Headline", { x: 40, y: photoH + 30, w: W - 80, h: H - photoH - 60 }, applyHighlights("My website that converts bank statements makes over $40,000 every month", [{ phrase: "$40,000", color: "green" }]), baseText({
      fontId: "anton", sizePx: 92, lineHeight: 1.06, align: "center", valign: "middle", uppercase: true, autoFit: true, minSizePx: 48,
    }), { slot: ai("A first-person quote of 9–15 words — what the founder built and its TRUE headline number, as they'd say it: \"My website that converts bank statements makes over $40,000 every month\", \"I vibe coded an app on my morning commute. It made $30,000 & I quit my job\". No quotation marks. Highlight the number green.") }),
  ];
  return { id: newElementId("page"), background: "#000000", elements };
}

export function buildTmzTemplate(): DesignDoc {
  return { version: 1, canvas: { ...IG_PORTRAIT }, template: TMZ_TEMPLATE, pages: [buildTmzPage()] };
}
