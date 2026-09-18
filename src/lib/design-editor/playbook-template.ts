/**
 * The "Instagram PLAYBOOK" template — turns an AI brief into a DesignDoc.
 *
 * Modelled directly on the format's best-performing posts (Sept 2026):
 *   page 1 — the founder's photo, a huge revenue stat, an all-caps headline
 *            with a phrase or two highlighted red/green, the Starter Story ·
 *            HubSpot Media wordmark, "See his 3-Phase playbook→" footer;
 *   page 2 — the playbook itself, styled as an iOS Notes screenshot.
 *
 * The brief is CONTENT only (what the stat is, what the phases say). This
 * file owns the design. Everything it emits is ordinary elements the editor
 * can move, restyle or delete — there is nothing template-specific left in
 * the document once it's built.
 */
import { IG_SQUARE, newElementId, type DesignDoc, type DesignElement, type DesignImageSource, type DesignPage, type DesignSpan, type DesignTextElement, type DesignTextStyle } from "./doc";
import { layoutDesignText } from "./layout";

export interface PlaybookBrief {
  /** The big number: "$720K", "2,000", "38%". */
  stat: string;
  /** What the number is: "/year", "customer calls", "profit margin". */
  statUnit: string;
  /** Sentence-case is fine; the template uppercases. */
  headline: string;
  /** Exact phrases of `headline` to colour. */
  highlights: Array<{ phrase: string; color: "red" | "green" }>;
  footer: string;
  notesTitle: string;
  phases: Array<{ heading: string; body: string }>;
  caption: string;
}

export const PLAYBOOK_TEMPLATE = "playbook-v1";

const RED = "#FF3B3B";
const GREEN = "#22E07A";
const WORDMARK: DesignImageSource = { kind: "asset", path: "/watermarks/starter-story-hubspot-media-white.png" };

const baseText = (over: Partial<DesignTextStyle>): DesignTextStyle => ({
  fontId: "inter-regular",
  sizePx: 32,
  lineHeight: 1.25,
  color: "#FFFFFF",
  align: "left",
  valign: "top",
  uppercase: false,
  shadow: null,
  autoFit: false,
  minSizePx: 12,
  ...over,
});

/** Split text into spans so each highlighted phrase gets its colour.
 *  Case-insensitive, first occurrence, phrases that don't appear are
 *  ignored (the model sometimes paraphrases its own headline). */
export function applyHighlights(
  text: string,
  highlights: Array<{ phrase: string; color: "red" | "green" }>,
): DesignSpan[] {
  const marks: Array<{ start: number; end: number; color: string }> = [];
  const lower = text.toLowerCase();
  for (const h of highlights) {
    const phrase = h.phrase.trim().toLowerCase();
    if (!phrase) continue;
    const start = lower.indexOf(phrase);
    if (start < 0) continue;
    const end = start + phrase.length;
    if (marks.some((m) => start < m.end && end > m.start)) continue; // overlap
    marks.push({ start, end, color: h.color === "red" ? RED : GREEN });
  }
  marks.sort((a, b) => a.start - b.start);
  const spans: DesignSpan[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) spans.push({ text: text.slice(cursor, m.start) });
    spans.push({ text: text.slice(m.start, m.end), color: m.color });
    cursor = m.end;
  }
  if (cursor < text.length || spans.length === 0) spans.push({ text: text.slice(cursor) });
  return spans;
}

function text(name: string, box: { x: number; y: number; w: number; h: number }, spans: DesignSpan[], style: DesignTextStyle): DesignTextElement {
  return { id: newElementId("t"), name, type: "text", ...box, opacity: 1, locked: false, spans, style };
}

export function buildCoverPage(brief: PlaybookBrief, photo: DesignImageSource | null): DesignPage {
  const { width: W, height: H } = IG_SQUARE;
  const elements: DesignElement[] = [];
  if (photo) {
    elements.push({ id: newElementId("img"), name: "Photo", type: "image", x: 0, y: 0, w: W, h: H, opacity: 1, locked: false, src: photo, fit: "cover", radius: 0 });
  }
  elements.push({
    id: newElementId("r"), name: "Shade", type: "rect", x: 0, y: 380, w: W, h: H - 380, opacity: 1, locked: false,
    fill: { color: "#000000", alpha: 0 }, gradientTo: { color: "#000000", alpha: 0.92 }, radius: 0,
  });
  // 2249×519 wordmark at 300 wide.
  elements.push({ id: newElementId("img"), name: "Logo", type: "image", x: W - 40 - 300, y: 40, w: 300, h: 69, opacity: 1, locked: false, src: WORDMARK, fit: "contain", radius: 0 });
  elements.push(
    text("Stat", { x: 300, y: 120, w: 740, h: 260 }, [{ text: brief.stat }], baseText({
      fontId: "anton", sizePx: 230, lineHeight: 1, align: "right", valign: "bottom", autoFit: true, minSizePx: 90,
      shadow: { color: "#000000", alpha: 0.6, blur: 0, x: 12, y: 12 },
    })),
    text("Stat unit", { x: 300, y: 385, w: 740, h: 72 }, [{ text: brief.statUnit }], baseText({
      fontId: "montserrat-medium", sizePx: 58, lineHeight: 1.1, align: "right", autoFit: true, minSizePx: 24,
      shadow: { color: "#000000", alpha: 0.5, blur: 8, x: 0, y: 4 },
    })),
    text("Headline", { x: 50, y: 540, w: W - 100, h: 400 }, applyHighlights(brief.headline, brief.highlights), baseText({
      fontId: "anton", sizePx: 78, lineHeight: 1.12, align: "center", valign: "bottom", uppercase: true, autoFit: true, minSizePx: 40,
      shadow: { color: "#000000", alpha: 0.85, blur: 22, x: 0, y: 8 },
    })),
    text("Footer", { x: 60, y: 985, w: W - 120, h: 50 }, footerSpans(brief.footer), baseText({
      fontId: "inter-regular", sizePx: 34, lineHeight: 1.2, align: "center", autoFit: true, minSizePx: 20,
    })),
  );
  return { id: newElementId("page"), background: "#0B0B0B", elements };
}

/** "See his 3-Phase playbook→": the "N-Phase"/"N-Step" token goes green. A
 *  structural pattern (digits + word), not content analysis. */
function footerSpans(footer: string): DesignSpan[] {
  const m = /\b\d+[- ][A-Za-z]+\b/.exec(footer);
  if (!m) return [{ text: footer }];
  return applyHighlights(footer, [{ phrase: m[0], color: "green" }]);
}

export function buildNotesPage(brief: PlaybookBrief): DesignPage {
  const { width: W, height: H } = IG_SQUARE;
  const M = 44; // side margin
  const bodyW = W - 2 * M;
  // Shrink everything together until it fits the page — a 5-phase
  // playbook with long bodies must still be one clean screenshot.
  for (let scale = 1; scale >= 0.55; scale -= 0.05) {
    const s = (n: number) => Math.round(n * scale);
    const elements: DesignElement[] = [];
    const notesBlue = "#C7891E";
    elements.push(
      text("Back", { x: M, y: 30, w: 300, h: 40 }, [{ text: "‹ Reminder" }], baseText({ fontId: "inter-regular", sizePx: 32, color: notesBlue })),
      text("Done", { x: W - M - 300, y: 30, w: 300, h: 40 }, [{ text: "Done" }], baseText({ fontId: "inter-semibold", sizePx: 32, color: notesBlue, align: "right" })),
      text("Date", { x: M, y: 92, w: bodyW, h: 34 }, [{ text: todayLabel() }], baseText({ fontId: "inter-regular", sizePx: 24, color: "#8E8E93", align: "center" })),
    );
    let y = 150;
    elements.push(text("Title", { x: M, y, w: bodyW, h: s(50) }, [{ text: brief.notesTitle }], baseText({ fontId: "inter-bold", sizePx: s(38), lineHeight: 1.2, color: "#1C1C1E", autoFit: true, minSizePx: 20 })));
    y += s(50) + s(30);
    for (const [i, phase] of brief.phases.entries()) {
      const heading = text(`Phase ${i + 1} heading`, { x: M, y, w: bodyW, h: s(38) }, [{ text: phase.heading }], baseText({ fontId: "inter-bold", sizePx: s(30), lineHeight: 1.2, color: "#1C1C1E", autoFit: true, minSizePx: 18 }));
      elements.push(heading);
      y += s(38) + s(6);
      const body = text(`Phase ${i + 1} body`, { x: M, y, w: bodyW, h: 2000 }, [{ text: phase.body }], baseText({ fontId: "inter-regular", sizePx: s(29), lineHeight: 1.35, color: "#1C1C1E" }));
      body.h = Math.ceil(layoutDesignText(body).blockHeightPx);
      elements.push(body);
      y += body.h + s(34);
    }
    if (y <= H - 30 || scale <= 0.56) {
      return { id: newElementId("page"), background: "#F7F5EF", elements };
    }
  }
  throw new Error("unreachable");
}

function todayLabel(): string {
  const d = new Date();
  const date = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

export function buildPlaybookDoc(brief: PlaybookBrief, photo: DesignImageSource | null): DesignDoc {
  return {
    version: 1,
    canvas: { ...IG_SQUARE },
    template: PLAYBOOK_TEMPLATE,
    pages: [buildCoverPage(brief, photo), buildNotesPage(brief)],
  };
}
