/**
 * The "hero" cover — what the best-performing Starter Story covers do by
 * hand in Canva (Sept 2026, e.g. the $160K/month gym-app post):
 *
 *   the founder CUT OUT of their photo, standing over a dimmed version of
 *   the same shot, with a tilted dashboard stat card ("Revenue · $160,324 ·
 *   Last 28 days" + a green chart) thrown in BEHIND them so they overlap it;
 *   the all-caps Anton headline across the lower half with the number in
 *   green and the contrast word in red; a one-line footer; the wordmark.
 *
 * As a TEMPLATE page: the backdrop is a `photo` slot (the filmstrip's
 * pick), the person a `cutout` slot (filled when the cutout lands), the
 * stat card and texts are AI slots. `buildHeroCover()` is the page; the
 * `playbook-hero` preset is the PLAYBOOK carousel with this cover in front,
 * and the editor's "Hero cover" action rebuilds page 1 of any post from it.
 */
import { DEFAULT_CROP, IG_SQUARE, newElementId, shadeElement, type DesignDoc, type DesignElement, type DesignImageSource, type DesignPage } from "./doc";
import { ai, baseText, cutoutSlot, photoSlot, statCard, text } from "./shared";
import { applyHighlights } from "./template-fill";
import { buildPlaybookTemplate, PLAYBOOK_TEMPLATE } from "./playbook-template";

export const HERO_COVER_TEMPLATE = "playbook-hero-v1";

const WORDMARK: DesignImageSource = { kind: "asset", path: "/watermarks/starter-story-hubspot-media-white.png" };

export const HERO_HEADLINE_HINT = "8–14 words, first or third person like the past posts, the founder's result with its TRUE number: \"He built in a brutally saturated niche then A/B tested to reach $160K/month\", \"I flipped 6 apps, then sold my 7th for $1M\". Highlight the number/outcome green and the pain/contrast phrase red.";
export const HERO_FOOTER_HINT = "A one-line teaser of what the rest of the carousel delivers, ending with →: \"See his 5-phase playbook →\", \"His full tech stack →\", \"The 3 tactics that did it →\". Highlight the \"N-phase\"/\"N-step\" token green when there is one.";
export const HERO_STAT_HINT = "The founder's headline metric as a dashboard would show it — the SAME number as the headline when the headline has one.";

/** The hero page for a canvas (square by default). */
export function buildHeroCover(canvas: { width: number; height: number } = IG_SQUARE): DesignPage {
  const { width: W, height: H } = canvas;
  const elements: DesignElement[] = [];
  // 1. The backdrop: the cover photo itself, zoomed in and dimmed, so the
  //    cutout stands in its own room (the reference posts keep the real
  //    background, darkened, rather than a flat colour).
  elements.push({ ...photoSlot({ x: 0, y: 0, w: W, h: H }), name: "Backdrop", crop: { x: 0.5, y: 0.45, zoom: 1.35 } });
  elements.push({ id: newElementId("r"), name: "Dim", type: "rect", x: 0, y: 0, w: W, h: H, opacity: 1, locked: false, slot: null, stack: null, fill: { color: "#000000", alpha: 0.7 }, gradientTo: null, gradientDirection: "down", radius: 0 });
  // 2. The stat card, tilted, on the left — BEHIND the founder.
  elements.push(statCard({ x: Math.round(W * 0.06), y: Math.round(H * 0.17), w: Math.round(W * 0.5), h: Math.round(H * 0.3) }, { rotation: -6, slot: ai(HERO_STAT_HINT) }));
  // 3. The founder, cut out, large, on the right, standing on the bottom edge.
  elements.push(cutoutSlot({ x: Math.round(W * 0.3), y: Math.round(H * 0.06), w: Math.round(W * 0.68), h: Math.round(H * 0.94) }));
  // 4. The shade and the type over everything.
  elements.push({ ...shadeElement(canvas, "bottom"), y: Math.round(H * 0.42), h: H - Math.round(H * 0.42) });
  elements.push({ id: newElementId("img"), name: "Logo", type: "image", x: W - 40 - 300, y: 40, w: 300, h: 69, opacity: 1, locked: false, src: WORDMARK, fit: "contain", radius: 0, crop: { ...DEFAULT_CROP }, slot: null, stack: null });
  elements.push(
    text("Headline", { x: 50, y: Math.round(H * 0.52), w: W - 100, h: Math.round(H * 0.36) }, applyHighlights("He built in a brutally saturated niche then A/B tested to reach $160K/month", [{ phrase: "saturated niche", color: "red" }, { phrase: "$160K/month", color: "green" }]), baseText({
      fontId: "anton", sizePx: 96, lineHeight: 1.04, align: "center", valign: "bottom", uppercase: true, autoFit: true, minSizePx: 48,
      shadow: { color: "#000000", alpha: 0.75, blur: 20, x: 0, y: 6 },
    }), { slot: ai(HERO_HEADLINE_HINT) }),
    text("Footer", { x: 60, y: H - 105, w: W - 120, h: 50 }, applyHighlights("See his 5-phase playbook →", [{ phrase: "5-phase", color: "green" }]), baseText({
      fontId: "inter-regular", sizePx: 34, lineHeight: 1.2, align: "center", autoFit: true, minSizePx: 20,
    }), { slot: ai(HERO_FOOTER_HINT) }),
  );
  return { id: newElementId("page"), background: "#0B0B0B", elements };
}

/** The PLAYBOOK carousel with the hero cover in front. */
export function buildPlaybookHeroTemplate(): DesignDoc {
  const playbook = buildPlaybookTemplate();
  return { ...playbook, template: HERO_COVER_TEMPLATE, pages: [buildHeroCover(playbook.canvas), ...playbook.pages.slice(1)] };
}

export { PLAYBOOK_TEMPLATE };
