/**
 * The "Full Story Slideshow (IG)" preset — a format TEMPLATE modelled on the
 * format's best posts (Sept 2026; e.g. the Guillaume/$150M SaaS story):
 *   page 1    — the founder's photo, wordmark top-left, a black fade, an
 *               all-caps headline with the money line in green,
 *               "Swipe for the full story →";
 *   pages 2–10 — one story beat each: a still of the video over the top
 *               half, a black lower half with 40–70 words of narration,
 *               the pain in red and the wins in green. Beats 5–10 are
 *               optional — the AI leaves the ones a shorter story doesn't
 *               need empty and the page disappears;
 *   last page — "WE SHARE STORIES LIKE THIS TO INSPIRE BUILDERS LIKE YOU"
 *               over another still, the wordmark under it.
 */
import { DEFAULT_CROP, IG_SQUARE, newElementId, shadeElement, type DesignDoc, type DesignElement, type DesignImageSource, type DesignPage } from "./doc";
import { ai, baseText, frameSlot, photoSlot, text } from "./shared";
import { applyHighlights } from "./template-fill";

export const STORY_TEMPLATE = "story-v1";

const WORDMARK: DesignImageSource = { kind: "asset", path: "/watermarks/starter-story-hubspot-media-white.png" };
const BLACK = "#000000";

/** Real beats from the Guillaume story — the style example for each slot. */
const SAMPLE_BEATS: Array<{ text: string; highlights: Array<{ phrase: string; color: "red" | "green" }> }> = [
  { text: "Guillaume had only $1,000 left to his name. No investors, no family money, no safety net. Everything he owned fit inside one nearly empty bank account.\n\nand he knew it would not last long...", highlights: [{ phrase: "last long...", color: "red" }] },
  { text: "His first business was supposed to change everything.\n\nBut after months of late nights and high expectations, he sold only 6 t-shirts doing ecommerce. This failure cost more than just money.\n\nIt filled him with shame and strained his relationship with his father.", highlights: [{ phrase: "cost more than just money.", color: "red" }] },
  { text: "He then joined a lead generation agency, not because it was his dream, but because he needed to survive.\n\nThere, he learned sales, prospecting, and how companies actually generate revenue. For the first time, he understood how money flows through business. But building an agency was the last thing he wanted to do.", highlights: [{ phrase: "how companies actually generate revenue.", color: "green" }, { phrase: "last thing", color: "red" }] },
  { text: "He spent his remaining savings building a startup\n  • moved countries\n  • hired developers\n  • bet everything on the idea\n\nThen one line of code changed, and the entire product stopped working.\n\nYears of effort disappeared in 1 night.", highlights: [{ phrase: "Years of effort disappeared in 1 night.", color: "red" }] },
  { text: "This time, he stopped chasing \"genius\" ideas. Instead, he studied markets already making money. Competition meant demand, and demand meant opportunity.\n\nRather than reinventing the wheel, he focused on one clear advantage: making sales outreach feel human and tying results directly to revenue.", highlights: [{ phrase: "stopped chasing", color: "red" }, { phrase: "studied markets already making money", color: "green" }] },
  { text: "The MVP took two weeks to build. He didn't chase perfection, only speed. He closed the first 100 customers himself, ran live demos, and even built campaigns for them personally. Customers became case studies, and case studies fueled growth.", highlights: [{ phrase: "case studies fueled growth.", color: "green" }] },
  { text: "Growth came quickly.\n\nThe product made $600 in its first month and began growing 40% month over month. Then everything stopped.\n\nAngry customers complained publicly, and the community turned on him. Instead of reversing course, he rebuilt the product.", highlights: [{ phrase: "$600 in its first month", color: "green" }, { phrase: "40% month over month", color: "green" }] },
  { text: "Four years later, the company reached $30 million in annual recurring revenue, served customers in more than 100 countries, and achieved a $150 million valuation.\n\nBut the greatest change was not financial. He repaired his relationship with his family, helped his parents retire, and found peace in the journey.", highlights: [{ phrase: "$150 million valuation.", color: "green" }, { phrase: "repaired his relationship with his family,", color: "green" }] },
  { text: "(Beat 9 — only if the story needs it.)", highlights: [] },
];

export function buildStoryCover(): DesignPage {
  const { width: W, height: H } = IG_SQUARE;
  const elements: DesignElement[] = [];
  elements.push(photoSlot({ x: 0, y: 0, w: W, h: H }));
  elements.push({ ...shadeElement(IG_SQUARE, "bottom"), y: 420, h: H - 420 });
  elements.push({ id: newElementId("img"), name: "Logo", type: "image", x: 40, y: 34, w: 280, h: 64, opacity: 1, locked: false, src: WORDMARK, fit: "contain", radius: 0, crop: { ...DEFAULT_CROP }, slot: null, stack: null });
  elements.push(
    text("Headline", { x: 50, y: 610, w: W - 100, h: 330 }, applyHighlights("This guy went from his last $1,000 to a $150M SaaS", [{ phrase: "$150M SaaS", color: "green" }]), baseText({
      fontId: "anton", sizePx: 92, lineHeight: 1.08, align: "center", valign: "bottom", uppercase: true, autoFit: true, minSizePx: 48,
      shadow: { color: "#000000", alpha: 0.7, blur: 18, x: 0, y: 6 },
    }), { slot: ai("8–14 words, third person, the arc in one line — where they started → the outcome with the exact number: \"This guy went from his last $1,000 to a $150M SaaS\". Highlight the outcome/number green.") }),
    text("Footer", { x: 60, y: 975, w: W - 120, h: 50 }, [{ text: "Swipe for the full story →" }], baseText({ fontId: "inter-regular", sizePx: 34, lineHeight: 1.2, align: "center", autoFit: true, minSizePx: 20 })),
  );
  return { id: newElementId("page"), background: BLACK, elements };
}

function beatPage(i: number, sample: (typeof SAMPLE_BEATS)[number]): DesignPage {
  const { width: W, height: H } = IG_SQUARE;
  const photoH = 590;
  const optional = i >= 4;
  const elements: DesignElement[] = [
    frameSlot({ x: 0, y: 0, w: W, h: photoH }),
    text(`Beat ${i + 1}`, { x: 44, y: photoH + 44, w: W - 88, h: H - photoH - 74 }, applyHighlights(sample.text, sample.highlights), baseText({
      fontId: "inter-regular", sizePx: 34, lineHeight: 1.36, color: "#FFFFFF", align: "left", valign: "top", autoFit: true, minSizePx: 22,
    }), { slot: ai(`Story beat ${i + 1} of up to 9, in order: 35–70 words of narration in the past tense, third person, short sentences, with the specifics the founder gave (numbers, names, what exactly happened). Blank line between paragraphs; a bullet list ("  • ") when they list things. Highlight the pain/setback red and the win/number green — one or two phrases, exact substrings.${optional ? " Leave EMPTY if the story is told by then (most stories take 6–8 beats)." : ""}`) }),
  ];
  return { id: newElementId("page"), background: BLACK, elements };
}

export function buildStoryCloser(): DesignPage {
  const { width: W, height: H } = IG_SQUARE;
  const elements: DesignElement[] = [
    frameSlot({ x: 0, y: 0, w: W, h: H }),
    { ...shadeElement(IG_SQUARE, "bottom"), y: 480, h: H - 480 },
    text("Sign-off", { x: 50, y: 730, w: W - 100, h: 190 }, [{ text: "We share stories like this to inspire builders like you" }], baseText({
      fontId: "anton", sizePx: 78, lineHeight: 1.08, align: "center", valign: "bottom", uppercase: true, autoFit: true, minSizePx: 40,
      shadow: { color: "#000000", alpha: 0.7, blur: 18, x: 0, y: 6 },
    })),
    { id: newElementId("img"), name: "Logo", type: "image", x: (W - 340) / 2, y: 950, w: 340, h: 78, opacity: 1, locked: false, src: WORDMARK, fit: "contain", radius: 0, crop: { ...DEFAULT_CROP }, slot: null, stack: null },
  ];
  return { id: newElementId("page"), background: BLACK, elements };
}

export function buildStoryTemplate(): DesignDoc {
  return {
    version: 1,
    canvas: { ...IG_SQUARE },
    template: STORY_TEMPLATE,
    pages: [buildStoryCover(), ...SAMPLE_BEATS.map((b, i) => beatPage(i, b)), buildStoryCloser()],
  };
}
