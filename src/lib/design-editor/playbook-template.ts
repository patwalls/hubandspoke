/**
 * The "Instagram PLAYBOOK" preset — a format TEMPLATE (a DesignDoc with
 * slots, see template-fill.ts) modelled directly on the format's
 * best-performing posts (Sept 2026):
 *   page 1 — the founder's photo, a huge revenue stat, an all-caps headline
 *            with a phrase or two highlighted red/green, the Starter Story ·
 *            HubSpot Media wordmark, "See his 3-Phase playbook→" footer;
 *   page 2 — the playbook itself, styled as an iOS Notes screenshot;
 *   pages 3–4 — two clips of the interview as YouTube cards.
 *
 * The sample content is a real post's, so the template reads like a post in
 * the editor and gives the AI its style example. Everything it emits is
 * ordinary elements the format owner can move, restyle, re-slot or delete.
 */
import { DEFAULT_CROP, IG_SQUARE, newElementId, type DesignDoc, type DesignElement, type DesignImageSource, type DesignPage } from "./doc";
import { ai, baseText, notesChrome, photoSlot, text, videoPageTemplate, NOTES_BG } from "./shared";
import { applyHighlights } from "./template-fill";

export const PLAYBOOK_TEMPLATE = "playbook-v1";

const WORDMARK: DesignImageSource = { kind: "asset", path: "/watermarks/starter-story-hubspot-media-white.png" };

export function buildPlaybookCover(): DesignPage {
  const { width: W, height: H } = IG_SQUARE;
  const elements: DesignElement[] = [];
  elements.push(photoSlot({ x: 0, y: 0, w: W, h: H }));
  elements.push({
    id: newElementId("r"), name: "Shade", type: "rect", x: 0, y: 380, w: W, h: H - 380, opacity: 1, locked: false,
    fill: { color: "#000000", alpha: 0 }, gradientTo: { color: "#000000", alpha: 0.92 }, radius: 0, slot: null, stack: null,
  });
  // 2249×519 wordmark at 300 wide.
  elements.push({ id: newElementId("img"), name: "Logo", type: "image", x: W - 40 - 300, y: 40, w: 300, h: 69, opacity: 1, locked: false, src: WORDMARK, fit: "contain", radius: 0, crop: { ...DEFAULT_CROP }, slot: null, stack: null });
  elements.push(
    text("Stat", { x: 300, y: 120, w: 740, h: 260 }, [{ text: "$720K" }], baseText({
      fontId: "anton", sizePx: 230, lineHeight: 1, align: "right", valign: "bottom", autoFit: true, minSizePx: 90,
      shadow: { color: "#000000", alpha: 0.6, blur: 0, x: 12, y: 12 },
    }), { slot: ai("The single most scroll-stopping TRUE number from the transcript: \"$720K\", \"2,000\", \"38%\". Never invent a figure; if no revenue is stated use a traction number they did state.") }),
    text("Stat unit", { x: 300, y: 385, w: 740, h: 72 }, [{ text: "/year" }], baseText({
      fontId: "montserrat-medium", sizePx: 58, lineHeight: 1.1, align: "right", autoFit: true, minSizePx: 24,
      shadow: { color: "#000000", alpha: 0.5, blur: 8, x: 0, y: 4 },
    }), { slot: ai("What the number is, 1–3 words: \"/year\", \"customer calls\", \"profit margin\".") }),
    text("Headline", { x: 50, y: 540, w: W - 100, h: 400 }, applyHighlights("I stopped guessing what customers wanted. 2,000 calls later I had a $69K/month SaaS", [{ phrase: "stopped guessing", color: "red" }, { phrase: "$69K/month SaaS", color: "green" }]), baseText({
      fontId: "anton", sizePx: 78, lineHeight: 1.12, align: "center", valign: "bottom", uppercase: true, autoFit: true, minSizePx: 40,
      shadow: { color: "#000000", alpha: 0.85, blur: 22, x: 0, y: 8 },
    }), { slot: ai("10–18 words, first or third person like the past posts, a before→after contrast the number pays off. Highlight one phrase red (the struggle or surprising claim) and one green (the outcome/number).") }),
    text("Footer", { x: 60, y: 985, w: W - 120, h: 50 }, applyHighlights("See his 3-Phase playbook→", [{ phrase: "3-Phase", color: "green" }]), baseText({
      fontId: "inter-regular", sizePx: 34, lineHeight: 1.2, align: "center", autoFit: true, minSizePx: 20,
    }), { slot: ai("\"See his 3-Phase playbook→\" — his/her/their to match the founder, the N matching the number of phases, ending with →. Highlight the \"N-Phase\" token green.") }),
  );
  return { id: newElementId("page"), background: "#0B0B0B", elements };
}

const SAMPLE_PHASES = [
  { heading: "Phase 1: Customer Discovery — Reach Out & Frame", body: "Reach out to your personal network or DM people on Twitter (pay them if needed) to get on a call. Follow The Mom Test principles; never ask hypothetical questions like \"would you use this?\" Instead, ask how they currently solve the problem, how much time/money it costs, and what happens if they do nothing." },
  { heading: "Phase 2: Usability Testing — Fight 1-to-1 for Users", body: "Acquire early users via Reddit threads, lead magnets, and waitlist signups, then immediately invite them to a call. Share a link to your platform, ask them to share their screen, and speak as little as possible." },
  { heading: "Phase 3: Customer Success — Track & Identify Power Users", body: "Use analytics tools like PostHog to track usage and identify the users who engage with the platform the most. Get on calls with power users to understand specifically how the platform is delivering value." },
  { heading: "Phase 4: (only if the playbook has a 4th phase)", body: "Leave this and the heading empty when the playbook has three phases — the page closes the gap." },
  { heading: "Phase 5: (only if the playbook has a 5th phase)", body: "Leave empty when unused." },
];

export function buildPlaybookNotes(): DesignPage {
  const { width: W } = IG_SQUARE;
  const M = 44;
  const bodyW = W - 2 * M;
  const elements: DesignElement[] = [...notesChrome()];
  let y = 150;
  elements.push(text("Title", { x: M, y, w: bodyW, h: 50 }, [{ text: "The 3-Phase Customer Call Playbook" }], baseText({ fontId: "inter-bold", sizePx: 38, lineHeight: 1.2, color: "#1C1C1E" }), { slot: ai("Name the playbook: \"The 3-Phase Customer Call Playbook\"."), stack: "notes" }));
  y += 50 + 30;
  SAMPLE_PHASES.forEach((phase, i) => {
    elements.push(text(`Phase ${i + 1} heading`, { x: M, y, w: bodyW, h: 38 }, [{ text: phase.heading }], baseText({ fontId: "inter-bold", sizePx: 30, lineHeight: 1.2, color: "#1C1C1E" }), { slot: ai(`Phase ${i + 1} heading as \"Phase ${i + 1}: <what> — <how>\".${i >= 3 ? " Leave EMPTY if the playbook has fewer phases." : ""}`), stack: "notes" }));
    y += 38 + 6;
    const bodyH = 40 * Math.ceil(phase.body.length / 60);
    elements.push(text(`Phase ${i + 1} body`, { x: M, y, w: bodyW, h: bodyH }, [{ text: phase.body }], baseText({ fontId: "inter-regular", sizePx: 29, lineHeight: 1.35, color: "#1C1C1E" }), { slot: ai(`Phase ${i + 1} body: 40–90 words, a step a reader could do this week with the specific tools/tactics/thresholds the founder described.${i >= 3 ? " Leave EMPTY if unused." : ""}`), stack: "notes" }));
    y += bodyH + 34;
  });
  return { id: newElementId("page"), background: NOTES_BG, elements };
}

export function buildPlaybookTemplate(): DesignDoc {
  const clip = (n: number) =>
    videoPageTemplate({
      clipHint: `A 20–60s moment where the founder explains a tactic from the playbook in their own words — concrete, quotable, self-contained. Clip ${n} of 2; the two clips must not overlap and should cover different phases. Start at the beginning of a sentence.`,
      pillHint: "The playbook's name as a 2–4 word badge: \"CUSTOMER CALLS PLAYBOOK\".",
      pillSample: "CUSTOMER CALLS PLAYBOOK",
      captions: true,
      titleSample: "How This SaaS Hit $69K/Month In Just 2 Months",
    });
  return {
    version: 1,
    canvas: { ...IG_SQUARE },
    template: PLAYBOOK_TEMPLATE,
    pages: [buildPlaybookCover(), buildPlaybookNotes(), clip(1), clip(2)],
  };
}
