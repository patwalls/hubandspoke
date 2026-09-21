/**
 * The "Instagram PLAYBOOK" preset — a format TEMPLATE (a DesignDoc with
 * slots, see template-fill.ts) modelled directly on the format's
 * best-performing posts (Sept 2026):
 *   page 1 — the founder's photo, an all-caps headline with the number in
 *            green, the Starter Story · HubSpot Media wordmark top-right,
 *            "my 5-step build & sell playbook →" footer;
 *   page 2 — the playbook itself, styled as an iOS Notes screenshot;
 *   page 3 — a clip of the interview as a YouTube card;
 *   page 4 — the CTA: a question about the product, "comment <KEYWORD> and
 *            i'll DM you the full video." and the channel row — the
 *            ManyChat keyword the post is attached to.
 *
 * The sample content is a real post's, so the template reads like a post in
 * the editor and gives the AI its style example. Everything it emits is
 * ordinary elements the format owner can move, restyle, re-slot or delete.
 */
import { DEFAULT_CROP, IG_SQUARE, newElementId, shadeElement, type DesignDoc, type DesignElement, type DesignImageSource, type DesignPage } from "./doc";
import { ai, baseText, channelElement, notesChrome, photoSlot, sys, text, videoPageTemplate, DM_KEYWORD_TOKEN, NOTES_BG } from "./shared";
import { applyHighlights } from "./template-fill";

export const PLAYBOOK_TEMPLATE = "playbook-v1";

const WORDMARK: DesignImageSource = { kind: "asset", path: "/watermarks/starter-story-hubspot-media-white.png" };

export function buildPlaybookCover(): DesignPage {
  const { width: W, height: H } = IG_SQUARE;
  const elements: DesignElement[] = [];
  elements.push(photoSlot({ x: 0, y: 0, w: W, h: H }));
  elements.push({ ...shadeElement(IG_SQUARE, "bottom"), y: 420, h: H - 420 });
  // 2249×519 wordmark at 300 wide.
  elements.push({ id: newElementId("img"), name: "Logo", type: "image", x: W - 40 - 300, y: 40, w: 300, h: 69, opacity: 1, locked: false, src: WORDMARK, fit: "contain", radius: 0, crop: { ...DEFAULT_CROP }, slot: null, stack: null });
  elements.push(
    text("Headline", { x: 50, y: 620, w: W - 100, h: 320 }, applyHighlights("I flipped 6 apps, then sold my 7th for $1M", [{ phrase: "for $1M", color: "green" }]), baseText({
      fontId: "anton", sizePx: 92, lineHeight: 1.08, align: "center", valign: "bottom", uppercase: true, autoFit: true, minSizePx: 48,
      shadow: { color: "#000000", alpha: 0.7, blur: 18, x: 0, y: 6 },
    }), { slot: ai("8–14 words, first or third person like the past posts, the founder's result with its TRUE number: \"I flipped 6 apps, then sold my 7th for $1M\", \"Her B2B AI SaaS scaled to $60K/month in less than 60 days\". Highlight the number/outcome green; a contrast word may be red.") }),
    text("Footer", { x: 60, y: 975, w: W - 120, h: 50 }, applyHighlights("my 5-step build & sell playbook →", [{ phrase: "5-step", color: "green" }]), baseText({
      fontId: "inter-regular", sizePx: 34, lineHeight: 1.2, align: "center", autoFit: true, minSizePx: 20,
    }), { slot: ai("\"my 5-step build & sell playbook →\" / \"Her app launch playbook →\" / \"See his 5-step validation Playbook →\" — the founder's pronoun, the N matching the number of steps, ending with →. Highlight the \"N-step\" token green.") }),
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

function buildPlaybookCta(): DesignPage {
  const { width: W } = IG_SQUARE;
  const M = 110;
  const elements: DesignElement[] = [
    text("Question", { x: M, y: 300, w: W - 2 * M, h: 70 }, [{ text: "curious how she runs those customer calls?" }], baseText({ fontId: "inter-regular", sizePx: 40, lineHeight: 1.3, color: "#141414" }), { slot: ai("A lowercase one-line question teasing the playbook: \"curious how she runs those customer calls?\", \"want the full validation playbook?\"."), stack: "cta" }),
    text("CTA", { x: M, y: 420, w: W - 2 * M, h: 130 }, [{ text: `comment "${DM_KEYWORD_TOKEN}" and i'll DM you the full video.` }], baseText({ fontId: "inter-regular", sizePx: 40, lineHeight: 1.3, color: "#141414" }), { slot: sys("dmKeyword"), stack: "cta" }),
    channelElement({ x: M, y: 620, w: W - 2 * M, h: 68 }),
  ];
  return { id: newElementId("page"), background: "#FFFFFF", elements };
}

export function buildPlaybookTemplate(): DesignDoc {
  const clip = videoPageTemplate({
    clipHint: "A 20–60s moment where the founder explains a tactic from the playbook in their own words — concrete, quotable, self-contained. Start at the beginning of a sentence.",
    pillHint: "The playbook's name as a 2–4 word badge: \"CUSTOMER CALLS PLAYBOOK\".",
    pillSample: "CUSTOMER CALLS PLAYBOOK",
    captions: true,
    titleSample: "How This SaaS Hit $69K/Month In Just 2 Months",
  });
  return {
    version: 1,
    canvas: { ...IG_SQUARE },
    template: PLAYBOOK_TEMPLATE,
    pages: [buildPlaybookCover(), buildPlaybookNotes(), clip, buildPlaybookCta()],
  };
}
