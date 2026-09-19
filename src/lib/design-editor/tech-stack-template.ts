/**
 * The "Tech Stack Slideshow" preset — a format TEMPLATE modelled on the
 * format's published posts (Sept 2026):
 *   page 1 — founder photo over a cream band with a plain-sentence headline
 *            ("This guy's stupidly simple website makes $40,000 per month.")
 *            and a "Here's how much it profits →" sub-line;
 *   page 2 — iOS Notes: "here's his stack:" + one bullet per tool with its
 *            role and cost, and the estimated infra total;
 *   page 3 — a clip of the founder walking through the stack, as a YouTube
 *            card with a "TECH STACK" pill;
 *   page 4 — the CTA: "curious what his website does? comment BSC and i'll
 *            DM you the full video." + the channel row.
 */
import { IG_SQUARE, newElementId, type DesignDoc, type DesignElement, type DesignPage } from "./doc";
import { ai, baseText, channelRow, notesChrome, photoSlot, rect, text, videoPageTemplate, NOTES_BG } from "./shared";

export const TECH_STACK_TEMPLATE = "tech-stack-v1";
const BAND = "#F5F3EE";
const INK = "#141414";

function cover(): DesignPage {
  const { width: W, height: H } = IG_SQUARE;
  const bandY = 730;
  const elements: DesignElement[] = [
    photoSlot({ x: 0, y: 0, w: W, h: bandY + 20 }),
    rect("Band", { x: 0, y: bandY, w: W, h: H - bandY }, BAND, 0),
    text("Headline", { x: 50, y: bandY + 40, w: W - 100, h: 170 }, [{ text: "This guy's stupidly simple website makes $40,000 per month." }], baseText({ fontId: "inter-regular", sizePx: 50, lineHeight: 1.22, color: INK, align: "center", valign: "middle", autoFit: true, minSizePx: 30 }), { slot: ai("One plain sentence, 8–14 words, third person, the founder's most surprising TRUE result with the exact number: \"This guy's stupidly simple website makes $40,000 per month.\" Sentence case, ends with a period.") }),
    text("Sub line", { x: 50, y: bandY + 228, w: W - 100, h: 60 }, [{ text: "Here's how much it profits →" }], baseText({ fontId: "inter-semibold", sizePx: 34, lineHeight: 1.2, color: INK, align: "center", valign: "middle", autoFit: true, minSizePx: 22 }), { slot: ai("A 4–7 word tease of the next slide ending with →: \"Here's how much it profits →\", \"Here's his exact stack →\".") }),
  ];
  return { id: newElementId("page"), background: BAND, elements };
}

function notes(): DesignPage {
  const { width: W } = IG_SQUARE;
  const M = 44;
  const bodyW = W - 2 * M;
  const elements: DesignElement[] = [...notesChrome()];
  elements.push(
    text("Intro", { x: M, y: 170, w: bodyW, h: 44 }, [{ text: "here's his stack:" }], baseText({ fontId: "inter-regular", sizePx: 34, lineHeight: 1.3, color: INK }), { slot: ai("A lowercase intro line: \"here's his stack:\" (his/her/their)."), stack: "notes" }),
    text("Stack", { x: M, y: 250, w: bodyW, h: 340 }, [{ text: "• kotlin — backend (free)\n• next.js — frontend (free)\n• aws — backend hosting ($500/mo)\n• netlify — frontend hosting ($20/mo)\n• stripe — payments (~3%/txn)\n• brevo — transactional email ($20/mo)" }], baseText({ fontId: "inter-regular", sizePx: 34, lineHeight: 1.45, color: INK }), { slot: ai("One line per tool, 4–9 lines, each exactly \"• tool — what it's for (cost)\" in lowercase like the sample. ONLY tools the founder names in the transcript; costs only if stated (else \"(free)\" only when they say so, otherwise omit the parentheses)."), stack: "notes" }),
    text("Total", { x: M, y: 640, w: bodyW, h: 44 }, [{ text: "total estimated infra: ~$540/mo" }], baseText({ fontId: "inter-semibold", sizePx: 34, lineHeight: 1.3, color: INK }), { slot: ai("\"total estimated infra: ~$540/mo\" — the sum of the stated monthly costs. Leave EMPTY if no costs are stated."), stack: "notes" }),
  );
  return { id: newElementId("page"), background: NOTES_BG, elements };
}

function cta(): DesignPage {
  const { width: W } = IG_SQUARE;
  const M = 110;
  const elements: DesignElement[] = [
    text("Question", { x: M, y: 300, w: W - 2 * M, h: 70 }, [{ text: "curious what his website does?" }], baseText({ fontId: "inter-regular", sizePx: 40, lineHeight: 1.3, color: INK }), { slot: ai("A lowercase one-line question teasing the product: \"curious what his website does?\", \"curious what his apps do?\"."), stack: "cta" }),
    text("CTA", { x: M, y: 420, w: W - 2 * M, h: 130 }, [{ text: "comment \"BSC\" and i'll DM you the full video." }], baseText({ fontId: "inter-regular", sizePx: 40, lineHeight: 1.3, color: INK }), { slot: ai("comment \"<KEYWORD>\" and i'll DM you the full video. — KEYWORD is a short all-caps word from the business name or the video's topic (\"BSC\", \"DAILYWIN\")."), stack: "cta" }),
    ...channelRow(M, 620),
  ];
  return { id: newElementId("page"), background: "#FFFFFF", elements };
}

export function buildTechStackTemplate(): DesignDoc {
  return {
    version: 1,
    canvas: { ...IG_SQUARE },
    template: TECH_STACK_TEMPLATE,
    pages: [
      cover(),
      notes(),
      videoPageTemplate({
        clipHint: "The 20–60s moment where the founder walks through their tech stack / the tools they use and what each costs. Start at the beginning of a sentence.",
        pillHint: "A 2–3 word badge for the clip: \"TECH STACK\".",
        pillSample: "TECH STACK",
        captions: false,
        titleSample: "I make $40K/month with this one website",
      }),
      cta(),
    ],
  };
}
