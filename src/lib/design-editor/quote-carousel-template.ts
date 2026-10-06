/**
 * The "Quote Carousel" preset — a 4:5 podcast-quote carousel modelled on the
 * format's Canva template (Oct 2026):
 *   pages 1–5 — two stacked stills of the episode (host / guest close-ups,
 *               the wide two-shot), each half darkened toward its bottom with
 *               one line of the conversation over it, key words in yellow,
 *               a "→" swipe cue bottom-right;
 *   last page — the wide two-shot full-bleed under a navy wall with
 *               "Want the full story. Watch the episode to know."
 * The quotes are verbatim lines from the episode, in conversation order.
 */
import { IG_PORTRAIT, newElementId, type DesignDoc, type DesignElement, type DesignPage, type DesignRectElement } from "./doc";
import { ai, baseText, frameSlot, photoSlot, text } from "./shared";
import { applyHighlights } from "./template-fill";

export const QUOTE_CAROUSEL_TEMPLATE = "quote-carousel-v1";

const BG = "#111827";
const NAVY = "#1A3A73";
const TRACK = "Each quote is a VERBATIM line from the episode (lightly trimmed for length, never reworded), 8–22 words, no quotation marks. The pages read as one back-and-forth conversation in order. Highlight 1–2 key words or the number yellow — exact substrings.";

/** Each page: the two halves' shot, a sample line, its highlights, and what the line is for. */
const PAGES: Array<Array<{ shot: string; sample: string; highlights: string[]; role: string }>> = [
  [
    { shot: "Guest close-up", sample: "Guest quote sets up the story with a key phrase and a number in it.", highlights: ["key phrase", "number"], role: "The guest's opening line — sets up the story, with a key phrase and a number." },
    { shot: "Host close-up", sample: "Short reply with a number.", highlights: ["number"], role: "The host's short reaction, ideally with a number. 3–10 words." },
  ],
  [
    { shot: "Wide two-shot", sample: "Quote line one continues the thought, and ends with a punchy word here.", highlights: ["punchy word"], role: "The guest continues the thought, ending on a punchy word." },
    { shot: "Guest close-up", sample: "The big takeaway quote goes here — keep it to two lines.", highlights: [], role: "The guest's big takeaway — the most quotable line of the episode. Two lines max." },
  ],
  [
    { shot: "Host close-up", sample: "Host shares a personal detail with a specific stat like $XX,XXX here.", highlights: ["$XX,XXX"], role: "The host shares a personal detail with a specific stat." },
    { shot: "Wide two-shot", sample: "Guest counters with a surprising stat that lands the point with emphasis here.", highlights: ["surprising stat", "with emphasis"], role: "The guest counters with a surprising stat that lands the point." },
  ],
  [
    { shot: "Host close-up", sample: "Host question that sets up the next answer with one key word.", highlights: ["key word"], role: "A host question that sets up the next answer." },
    { shot: "Guest close-up", sample: "Guest answer mentions a key term and then finishes the thought here.", highlights: ["key term"], role: "The guest's answer to that question." },
  ],
  [
    { shot: "Wide two-shot", sample: "Host follow-up question that runs about two lines long goes here?", highlights: [], role: "A host follow-up question, about two lines." },
    { shot: "Guest close-up", sample: "Guest closing thought, with one highlighted word, ending on a strong line.", highlights: ["highlighted"], role: "The guest's closing thought — end on a strong line." },
  ],
];

function shade(y: number, h: number): DesignRectElement {
  return {
    id: newElementId("r"), name: "Shade", type: "rect", x: 0, y, w: IG_PORTRAIT.width, h, opacity: 1, locked: false, slot: null, stack: null,
    fill: { color: "#000000", alpha: 0 }, gradientTo: { color: "#0B0F17", alpha: 0.85 }, gradientDirection: "down", radius: 0,
  };
}

function quotePage(pageIndex: number, halves: (typeof PAGES)[number]): DesignPage {
  const { width: W, height: H } = IG_PORTRAIT;
  const halfH = H / 2;
  const elements: DesignElement[] = [];
  halves.forEach((half, i) => {
    const top = i * halfH;
    // The very first panel is the founder photo (the AI's best guest shot); every other panel gets its own still.
    const picture = pageIndex === 0 && i === 0 ? photoSlot : frameSlot;
    elements.push({ ...picture({ x: 0, y: top, w: W, h: halfH }), name: `Photo · ${half.shot}` });
    elements.push(shade(top + halfH * 0.45, halfH * 0.55));
    elements.push(
      text(`Quote ${pageIndex * 2 + i + 1}`, { x: 110, y: top + halfH - 175, w: W - 220, h: 140 }, applyHighlights(half.sample, half.highlights.map((phrase) => ({ phrase, color: "yellow" }))), baseText({
        fontId: "inter-regular", sizePx: 40, lineHeight: 1.3, align: "center", valign: "bottom", autoFit: true, minSizePx: 26,
      }), { slot: ai(`${half.role} Shot: ${half.shot.toLowerCase()}. ${TRACK}`) }),
    );
  });
  elements.push(text("Swipe arrow", { x: W - 120, y: H - 105, w: 80, h: 70 }, [{ text: "→" }], baseText({ fontId: "inter-bold", sizePx: 64, lineHeight: 1, align: "center", valign: "middle" })));
  return { id: newElementId("page"), background: BG, elements };
}

export function buildQuoteCarouselCloser(): DesignPage {
  const { width: W, height: H } = IG_PORTRAIT;
  const elements: DesignElement[] = [
    { ...frameSlot({ x: 0, y: 0, w: W, h: H }), name: "Photo · Wide two-shot" },
    {
      id: newElementId("r"), name: "Navy wall", type: "rect", x: 0, y: 0, w: W, h: 860, opacity: 1, locked: false, slot: null, stack: null,
      fill: { color: NAVY, alpha: 1 }, gradientTo: { color: NAVY, alpha: 0 }, gradientDirection: "down", radius: 0,
    },
    text("CTA", { x: 150, y: 210, w: 640, h: 400 }, applyHighlights("Want the\nfull story.\n\nWatch the episode\nto know.", [{ phrase: "full story", color: "yellow" }]), baseText({
      fontId: "inter-regular", sizePx: 64, lineHeight: 1.15, align: "left", valign: "top", autoFit: true, minSizePx: 36,
    })),
  ];
  return { id: newElementId("page"), background: NAVY, elements };
}

export function buildQuoteCarouselTemplate(): DesignDoc {
  return {
    version: 1,
    canvas: { ...IG_PORTRAIT },
    template: QUOTE_CAROUSEL_TEMPLATE,
    pages: [...PAGES.map((halves, i) => quotePage(i, halves)), buildQuoteCarouselCloser()],
  };
}
