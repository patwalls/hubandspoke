/**
 * Import a format template from a designer's PDF (a Canva export) — the
 * pure half. The model reads the PDF and calls `build_template` with a
 * SIMPLIFIED description of each page (`IMPORT_TOOL` below: boxes in the
 * PDF's own coordinates, text + highlight phrases, a slot per element);
 * `normalizeImportedTemplate` turns that into a real DesignDoc — picks the
 * nearest canvas size, scales every box and font size onto it, maps unknown
 * fonts/colours/slots to safe defaults, fills in ids — so whatever comes back
 * parses. The worker half (Claude call, retries, the import row) lives in
 * src/lib/services/design-editor/pdf-import.ts.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { FONT_IDS, type FontId } from "@/lib/clip-editor/doc";
import { CANVAS_SIZES, DEFAULT_CROP, PHOTO_PLACEHOLDER, newElementId, parseDesignDoc, type DesignDoc, type DesignElement, type DesignPage, type DesignSlot } from "./doc";
import { baseText } from "./shared";
import { HIGHLIGHT_COLORS, applyHighlights } from "./template-fill";

export const PDF_IMPORT_TEMPLATE = "pdf-import-v1";

const TEXT_SLOTS = ["static", "ai", "videoTitle", "channelName", "dmKeyword"] as const;
const PICTURE_SLOTS = ["photo", "frame", "placeholder"] as const;

export const IMPORT_TOOL: Anthropic.Tool = {
  name: "build_template",
  description: "Describe the PDF as a design template: one entry per page, elements in back-to-front order.",
  input_schema: {
    type: "object",
    required: ["pageWidth", "pageHeight", "pages"],
    properties: {
      pageWidth: { type: "number", description: "Width of one PDF page in the coordinate units you use for every box below." },
      pageHeight: { type: "number", description: "Height of one PDF page in the same units." },
      pages: {
        type: "array",
        items: {
          type: "object",
          required: ["background", "elements"],
          properties: {
            background: { type: "string", description: "#RRGGBB — the page's dominant flat colour." },
            elements: {
              type: "array",
              description: "Back to front (z-order). Boxes in page units, origin top-left.",
              items: {
                type: "object",
                required: ["type", "name", "x", "y", "w", "h"],
                properties: {
                  type: { type: "string", enum: ["text", "picture", "rect", "video", "channel"] },
                  name: { type: "string", description: "Short editor label: \"Headline\", \"Quote 1\", \"Photo · guest close-up\"." },
                  x: { type: "number" },
                  y: { type: "number" },
                  w: { type: "number" },
                  h: { type: "number" },
                  slot: { type: "string", enum: [...TEXT_SLOTS, ...PICTURE_SLOTS], description: "text: static | ai | videoTitle | channelName | dmKeyword. picture: photo (THE founder/guest photo — use once, on the cover) | frame (a different still of the video per slot) | placeholder (a logo/graphic the user swaps in)." },
                  hint: { type: "string", description: "For ai text and video: what the AI should write/pick for every post, specific and with a length (\"The guest's opening line, 8–20 words, verbatim from the episode…\")." },
                  text: { type: "string", description: "text: the text as shown in the PDF, placeholder brackets removed. \\n for hard line breaks the design depends on (not soft wraps)." },
                  highlights: { type: "array", items: { type: "object", required: ["phrase", "color"], properties: { phrase: { type: "string", description: "Exact substring of text." }, color: { type: "string", description: "#RRGGBB" } } } },
                  fontId: { type: "string", enum: [...FONT_IDS], description: "Closest bundled font." },
                  sizePx: { type: "number", description: "Font size in page units." },
                  lineHeight: { type: "number", description: "Line pitch / font size, e.g. 1.2." },
                  letterSpacing: { type: "number", description: "Extra spacing in em, e.g. 0.2 for wide tracking." },
                  color: { type: "string", description: "text: #RRGGBB. rect: fill #RRGGBB." },
                  align: { type: "string", enum: ["left", "center", "right"] },
                  valign: { type: "string", enum: ["top", "middle", "bottom"] },
                  uppercase: { type: "boolean" },
                  shadow: { type: "boolean", description: "text: a soft dark drop shadow." },
                  alpha: { type: "number", description: "rect: fill opacity 0–1." },
                  gradientTo: { type: "object", properties: { color: { type: "string" }, alpha: { type: "number" } }, description: "rect: the colour at the far end of a linear fade (fill → gradientTo)." },
                  gradientDirection: { type: "string", enum: ["down", "up"], description: "rect: down = fill at top; up = fill at bottom." },
                  radius: { type: "number", description: "Corner radius in page units." },
                  platform: { type: "string", enum: ["youtube", "instagram", "x", "tiktok", "linkedin", "threads"] },
                  theme: { type: "string", enum: ["light", "dark"] },
                },
              },
            },
          },
        },
      },
      notes: { type: "string", description: "One or two sentences for the user: what in the PDF couldn't be reproduced (radial gradients, custom fonts, logos to upload)." },
    },
  },
};

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (typeof v === "string" && (options as readonly string[]).includes(v) ? (v as T) : fallback);

/** "#abc", "abcdef", "#AABBCCDD" → "#AABBCC"; anything else → fallback. */
export function normalizeHex(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  let h = v.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split("").map((c) => c + c).join("");
  if (/^[0-9a-f]{8}$/i.test(h)) h = h.slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(h) ? `#${h.toUpperCase()}` : fallback;
}

/** The editor canvas whose aspect ratio is nearest the PDF page's. */
export function nearestCanvas(pageWidth: number, pageHeight: number): { width: number; height: number } {
  const aspect = pageHeight / pageWidth;
  let best = CANVAS_SIZES[0];
  for (const c of CANVAS_SIZES) if (Math.abs(c.height / c.width - aspect) < Math.abs(best.height / best.width - aspect)) best = c;
  return { width: best.width, height: best.height };
}

function slotFor(kind: string, hint: string): DesignSlot | null {
  if (kind === "static" || kind === "placeholder" || !kind) return null;
  return { kind: kind as DesignSlot["kind"], hint: kind === "ai" ? hint.slice(0, 800) : "" };
}

export type NormalizeResult = { ok: true; doc: DesignDoc; notes: string } | { ok: false; error: string };

export function normalizeImportedTemplate(raw: unknown): NormalizeResult {
  if (!isObj(raw)) return { ok: false, error: "The model returned no template" };
  const pageW = num(raw.pageWidth, 0);
  const pageH = num(raw.pageHeight, 0);
  if (pageW <= 0 || pageH <= 0) return { ok: false, error: "pageWidth/pageHeight missing" };
  const rawPages = Array.isArray(raw.pages) ? raw.pages.filter(isObj) : [];
  if (rawPages.length === 0) return { ok: false, error: "No pages" };

  const canvas = nearestCanvas(pageW, pageH);
  const sx = canvas.width / pageW;
  const sy = canvas.height / pageH;
  const box = (e: Raw) => {
    const x = clamp(Math.round(num(e.x, 0) * sx), -canvas.width, canvas.width * 2);
    const y = clamp(Math.round(num(e.y, 0) * sy), -canvas.height, canvas.height * 2);
    return { x, y, w: Math.max(1, Math.round(num(e.w, canvas.width) * sx)), h: Math.max(1, Math.round(num(e.h, 60) * sy)) };
  };
  const base = (e: Raw, fallbackName: string) => ({ name: str(e.name, fallbackName).slice(0, 60) || fallbackName, ...box(e), opacity: 1, locked: false, stack: null });

  const pages: DesignPage[] = rawPages.slice(0, 20).map((p) => {
    const elements: DesignElement[] = [];
    const rawEls = Array.isArray(p.elements) ? p.elements.filter(isObj) : [];
    let hasVideo = false;
    for (const e of rawEls.slice(0, 100)) {
      const type = str(e.type);
      if (type === "text") {
        const text = str(e.text).slice(0, 2000);
        if (!text.trim()) continue;
        const color = normalizeHex(e.color, "#FFFFFF");
        const highlights = (Array.isArray(e.highlights) ? e.highlights.filter(isObj) : []).map((h) => ({ phrase: str(h.phrase), color: normalizeHex(h.color, HIGHLIGHT_COLORS.yellow) })).filter((h) => h.phrase.trim());
        const sizePx = clamp(Math.round(num(e.sizePx, 32) * sx), 8, 600);
        elements.push({
          id: newElementId("t"), type: "text", ...base(e, "Text"),
          spans: applyHighlights(text, highlights).map((s) => (s.color && s.color.toUpperCase() === color ? { text: s.text } : s)),
          style: baseText({
            fontId: oneOf<FontId>(e.fontId, FONT_IDS, "inter-regular"),
            sizePx,
            lineHeight: clamp(num(e.lineHeight, 1.25), 0.7, 3),
            letterSpacing: clamp(num(e.letterSpacing, 0), -0.1, 1),
            color,
            align: oneOf(e.align, ["left", "center", "right"] as const, "left"),
            valign: oneOf(e.valign, ["top", "middle", "bottom"] as const, "top"),
            uppercase: e.uppercase === true,
            shadow: e.shadow === true ? { color: "#000000", alpha: 0.7, blur: 18, x: 0, y: 6 } : null,
            autoFit: true,
            minSizePx: clamp(Math.round(sizePx * 0.6), 8, 600),
          }),
          slot: slotFor(oneOf(e.slot, TEXT_SLOTS, "static"), str(e.hint)),
        });
      } else if (type === "picture") {
        const kind = oneOf(e.slot, PICTURE_SLOTS, "frame");
        elements.push({
          id: newElementId("img"), type: "image", ...base(e, kind === "placeholder" ? "Graphic" : "Photo"),
          src: { ...PHOTO_PLACEHOLDER }, fit: kind === "placeholder" ? "contain" : "cover", radius: Math.max(0, Math.round(num(e.radius, 0) * sx)), crop: { ...DEFAULT_CROP },
          slot: slotFor(kind, ""),
        });
      } else if (type === "rect") {
        const g = isObj(e.gradientTo) ? { color: normalizeHex(e.gradientTo.color, "#000000"), alpha: clamp(num(e.gradientTo.alpha, 1), 0, 1) } : null;
        elements.push({
          id: newElementId("r"), type: "rect", ...base(e, g ? "Shade" : "Box"), slot: null,
          fill: { color: normalizeHex(e.color, "#000000"), alpha: clamp(num(e.alpha, 1), 0, 1) }, gradientTo: g,
          gradientDirection: oneOf(e.gradientDirection, ["down", "up"] as const, "down"), radius: Math.max(0, Math.round(num(e.radius, 0) * sx)),
        });
      } else if (type === "video" && !hasVideo) {
        hasVideo = true;
        elements.push({
          id: newElementId("v"), type: "video", ...base(e, "Clip"), src: null, startSec: 0, endSec: 30, fit: "cover",
          radius: Math.max(0, Math.round(num(e.radius, 0) * sx)), crop: { ...DEFAULT_CROP },
          slot: { kind: "ai", hint: (str(e.hint) || "The most quotable 15–40s moment of the episode.").slice(0, 800) },
        });
      } else if (type === "channel") {
        elements.push({
          id: newElementId("ch"), type: "channel", ...base(e, "Channel"), slot: null, accountId: null,
          platform: oneOf(e.platform, ["youtube", "instagram", "x", "tiktok", "linkedin", "threads"] as const, "youtube"),
          showFollowers: true, theme: oneOf(e.theme, ["light", "dark"] as const, "dark"),
        });
      }
    }
    return { id: newElementId("page"), background: normalizeHex(p.background, "#000000"), elements };
  });

  const parsed = parseDesignDoc({ version: 1, canvas, template: PDF_IMPORT_TEMPLATE, pages });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, doc: parsed.doc, notes: str(raw.notes).slice(0, 600) };
}
