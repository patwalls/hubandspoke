/**
 * The "What My Apps Are & What They Do" preset — a 4:5 carousel modelled on
 * the format's best posts (Sept 2026; e.g. "I built 5 'boring' apps that
 * make $200K/month"):
 *   page 1     — the founder's photo, wordmark top-left, a black fade, an
 *                all-caps headline with the money green, "My apps and what
 *                they do →";
 *   pages 2–6  — one app each as an iOS Notes screenshot: "My App: Curator.io",
 *                a one-line result, three bullets (what it is, how users use
 *                it, who it's for), and a screenshot card of the app's site
 *                (a placeholder to swap — the AI can't browse). Apps 2–5 are
 *                optional: the AI leaves the pages a founder with fewer apps
 *                doesn't need empty and they disappear.
 */
import { DEFAULT_CROP, newElementId, shadeElement, type DesignDoc, type DesignElement, type DesignImageSource, type DesignPage } from "./doc";
import { ai, baseText, notesChrome, photoSlot, text, NOTES_BG } from "./shared";
import { applyHighlights } from "./template-fill";
import { IG_PORTRAIT } from "./tmz-template";

export const APPS_TEMPLATE = "apps-v1";

const WORDMARK: DesignImageSource = { kind: "asset", path: "/watermarks/starter-story-hubspot-media-white.png" };
const INK = "#1C1C1E";
/** A light "add a screenshot" card — the AI can't browse the app's site. */
const SCREENSHOT_PLACEHOLDER: DesignImageSource = { kind: "asset", path: "/design/screenshot-placeholder.png" };

const SAMPLE_APPS = [
  { name: "Curator.io", line: "Curator.io is part of a SaaS portfolio doing over $200K/month MRR", bullets: "• It's a social media aggregator app that lets users display social feeds seamlessly on websites and at live events\n• Users connect their social media channels, and the app automatically pulls and beautifully formats posts into a single stream\n• It's built for brands and event organizers who want to showcase user-generated content and increase website engagement" },
  { name: "Frill", line: "Frill raised $30K during its private launch and contributes to a combined $200K/month MRR", bullets: "• It's a customer feedback and product management tool that helps businesses track feature requests\n• Users collect ideas from their audience, organize them into an interactive product roadmap, and announce new feature rollouts\n• It's built for SaaS companies and product teams looking to cut down churn and build exactly what their users want" },
  { name: "Flook", line: "Fluke.co is part of a bootstrapped portfolio making over $200K/month MRR", bullets: "• It's a no-code user onboarding platform that lets software companies build interactive product tours\n• Users design custom tooltips, popups, and walkthroughs visually, pushing them live instantly without needing a developer to write code\n• It's built for product managers and growth marketers who want to improve user activation rates quickly" },
  { name: "Smiile", line: "Smiile.co makes over $200K/month in combined MRR across our portfolio", bullets: "• It's an innovative group ecard and workplace appreciation platform built specifically for the B2B space\n• Users create collaborative, high-quality digital cards for team milestones, farewells, or celebrations, letting entire teams sign and customize them\n• I've built this for remote and hybrid corporate teams looking for a modern, simple way to maintain workplace culture and celebrate together" },
  { name: "Juuno", line: "Juno.co makes over $200K/month in combined MRR across our portfolio", bullets: "• It's a cloud-based digital signage platform built for physical locations and brick-and-mortar storefronts\n• Users connect any screen to display dynamic, updated content, menus, announcements, and schedules effortlessly\n• I've built this for cafes, gyms, schools, and local shops that need a reliable way to manage their physical displays remotely" },
];

export function buildAppsCover(): DesignPage {
  const { width: W, height: H } = IG_PORTRAIT;
  const elements: DesignElement[] = [];
  elements.push(photoSlot({ x: 0, y: 0, w: W, h: H }));
  elements.push({ ...shadeElement(IG_PORTRAIT, "bottom"), y: 620, h: H - 620 });
  elements.push({ id: newElementId("img"), name: "Logo", type: "image", x: 40, y: 34, w: 280, h: 64, opacity: 1, locked: false, src: WORDMARK, fit: "contain", radius: 0, crop: { ...DEFAULT_CROP }, slot: null, stack: null });
  elements.push(
    text("Headline", { x: 50, y: 800, w: W - 100, h: 420 }, applyHighlights("I built 5 \"boring\" apps that make $200K/month", [{ phrase: "$200K/month", color: "green" }]), baseText({
      fontId: "anton", sizePx: 100, lineHeight: 1.06, align: "center", valign: "bottom", uppercase: true, autoFit: true, minSizePx: 52,
      shadow: { color: "#000000", alpha: 0.7, blur: 18, x: 0, y: 6 },
    }), { slot: ai("First person, 7–13 words: what they built and the TRUE headline number — \"I built 5 \\\"boring\\\" apps that make $200K/month\", \"I built my app in 2 weeks with AI then scaled it to $20K/month in 50 days\". Highlight the number green.") }),
    text("Footer", { x: 60, y: 1250, w: W - 120, h: 50 }, [{ text: "My apps and what they do →" }], baseText({ fontId: "inter-regular", sizePx: 34, lineHeight: 1.2, align: "center", autoFit: true, minSizePx: 20 }), { slot: ai("\"My apps and what they do →\" / \"My app and what it does ↓\" / \"Her apps and what they do →\" — matching the founder and the count, ending with →.") }),
  );
  return { id: newElementId("page"), background: "#000000", elements };
}

function appPage(i: number, sample: (typeof SAMPLE_APPS)[number]): DesignPage {
  const { width: W, height: H } = IG_PORTRAIT;
  const M = 44;
  const bodyW = W - 2 * M;
  const optional = i >= 1;
  const elements: DesignElement[] = [...notesChrome()];
  let y = 165;
  elements.push(text("App name", { x: M, y, w: bodyW, h: 48 }, [{ text: `My App: ${sample.name}` }], baseText({ fontId: "inter-bold", sizePx: 40, lineHeight: 1.2, color: INK }), { slot: ai(`\"My App: <name>\" for app ${i + 1} (\"App #${i + 1}: <name>\" when the founder numbers them). Apps in the order the founder presents them.${optional ? " Leave EMPTY if the founder has fewer apps." : ""}`), stack: "notes" }));
  y += 48 + 26;
  elements.push(text("Result", { x: M, y, w: bodyW, h: 90 }, [{ text: sample.line }], baseText({ fontId: "inter-regular", sizePx: 33, lineHeight: 1.3, color: INK }), { slot: ai(`One line on app ${i + 1}'s TRUE result: revenue, users, growth — \"Frill raised $30K during its private launch and contributes to a combined $200K/month MRR\".${optional ? " Leave EMPTY if unused." : ""}`), stack: "notes" }));
  y += 90 + 26;
  elements.push(text("Bullets", { x: M + 10, y, w: bodyW - 10, h: 360 }, [{ text: sample.bullets }], baseText({ fontId: "inter-regular", sizePx: 32, lineHeight: 1.34, color: INK }), { slot: ai(`Exactly three bullets for app ${i + 1}, each starting with \"• \" on its own line: (1) \"It's a …\" what it is, (2) \"Users …\" how it's used, (3) \"It's built for …\" / \"I've built this for …\" who it's for. Only what the founder said.${optional ? " Leave EMPTY if unused." : ""}`), stack: "notes" }));
  y += 360 + 34;
  const cardH = H - y - 40;
  elements.push({ id: newElementId("img"), name: "Screenshot", type: "image", x: M, y, w: bodyW, h: cardH, opacity: 1, locked: false, src: SCREENSHOT_PLACEHOLDER, fit: "cover", radius: 18, crop: { ...DEFAULT_CROP }, slot: null, stack: "notes" });
  return { id: newElementId("page"), background: NOTES_BG, elements };
}

export function buildAppsTemplate(): DesignDoc {
  return {
    version: 1,
    canvas: { ...IG_PORTRAIT },
    template: APPS_TEMPLATE,
    pages: [buildAppsCover(), ...SAMPLE_APPS.map((a, i) => appPage(i, a))],
  };
}
