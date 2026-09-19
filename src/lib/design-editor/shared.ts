/**
 * Pieces every template shares: the text helpers, the founder-photo slot,
 * the iOS-Notes chrome, the "YouTube card" video slide and the channel row.
 * A template file (playbook-template.ts, tech-stack-template.ts) composes
 * these into its pages; nothing here knows about any one format's brief.
 */
import { DEFAULT_CROP, DM_KEYWORD_TOKEN, IG_SQUARE, PHOTO_PLACEHOLDER, newElementId, type DesignChannelElement, type DesignElement, type DesignImageSource, type DesignPage, type DesignSlot, type DesignSpan, type DesignTextElement, type DesignTextStyle } from "./doc";

export { DM_KEYWORD_TOKEN };

/** What a template needs beyond the brief: the founder's picture, the
 *  source video (for video slides) and the brand's channel. */
export interface DesignContext {
  photo: DesignImageSource | null;
  source: { bucket: string | null; key: string; title: string | null } | null;
  /** For the legacy channelName/channelSubscribers text slots. */
  channel: { name: string; subscribers: string };
  /** The post's attached ManyChat keyword ("BOOTSTRAP"), if any. */
  dmKeyword?: string | null;
}

export interface ClipPick {
  startSec: number;
  endSec: number;
  label: string;
}

export const WORDMARK_DARK: DesignImageSource = { kind: "asset", path: "/watermarks/starter-story-hubspot-media-black.png" };
export const PILL_PURPLE = "#6B5BFF";
export const NOTES_BG = "#F7F5EF";

export const baseText = (over: Partial<DesignTextStyle>): DesignTextStyle => ({
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

export function text(name: string, box: { x: number; y: number; w: number; h: number }, spans: DesignSpan[], style: DesignTextStyle, extra: { slot?: DesignSlot | null; stack?: string | null } = {}): DesignTextElement {
  return { id: newElementId("t"), name, type: "text", ...box, opacity: 1, locked: false, spans, style, slot: extra.slot ?? null, stack: extra.stack ?? null };
}

export const ai = (hint: string): DesignSlot => ({ kind: "ai", hint });
export const sys = (kind: Exclude<DesignSlot["kind"], "ai">): DesignSlot => ({ kind, hint: "" });

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The founder-photo slot: shows the placeholder in the template, the
 *  picked frame once a post is drafted (template-fill.ts). */
export function photoSlot(box: Box, src: DesignImageSource = PHOTO_PLACEHOLDER): DesignElement {
  return { id: newElementId("img"), name: "Photo", type: "image", ...box, opacity: 1, locked: false, src, fit: "cover", radius: 0, crop: { ...DEFAULT_CROP }, slot: sys("photo"), stack: null };
}

function rect(name: string, box: Box, fill: string, radius: number): DesignElement {
  return { id: newElementId("r"), name, type: "rect", ...box, opacity: 1, locked: false, fill: { color: fill, alpha: 1 }, gradientTo: null, gradientDirection: "down", radius, slot: null, stack: null };
}

/** The top of an iOS Notes screenshot: "‹ Reminder", "Done", today's date. */
export function notesChrome(): DesignElement[] {
  const { width: W } = IG_SQUARE;
  const M = 44;
  const notesBlue = "#C7891E";
  return [
    text("Back", { x: M, y: 30, w: 300, h: 40 }, [{ text: "‹ Reminder" }], baseText({ fontId: "inter-regular", sizePx: 32, color: notesBlue })),
    text("Done", { x: W - M - 300, y: 30, w: 300, h: 40 }, [{ text: "Done" }], baseText({ fontId: "inter-semibold", sizePx: 32, color: notesBlue, align: "right" })),
    text("Date", { x: M, y: 92, w: W - 2 * M, h: 34 }, [{ text: todayLabel() }], baseText({ fontId: "inter-regular", sizePx: 24, color: "#8E8E93", align: "center" })),
  ];
}

function todayLabel(): string {
  const d = new Date();
  const date = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

/** The brand's channel — avatar, name ✓, follower count from `accounts`,
 *  live. One element; the box height is the avatar size. */
export function channelElement(box: Box, over: Partial<Pick<DesignChannelElement, "platform" | "theme" | "showFollowers">> = {}): DesignChannelElement {
  return { id: newElementId("ch"), name: "Channel", type: "channel", ...box, opacity: 1, locked: false, slot: null, stack: null, accountId: null, platform: "youtube", showFollowers: true, theme: "light", ...over };
}

/**
 * A video slide as the published posts do it — the "YouTube card": the
 * spoken line captioned above (optional), the clip in a rounded 16:9 box
 * with a purple pill over it, the video's title with a YouTube badge and the
 * channel row under it. As a TEMPLATE page: the clip and pill are AI slots,
 * the title/channel are system slots.
 */
export function videoPageTemplate(args: { clipHint: string; pillHint: string; pillSample: string; captions: boolean; titleSample: string }): DesignPage {
  const { width: W } = IG_SQUARE;
  const M = 30;
  const boxW = W - 2 * M;
  const boxH = Math.round((boxW * 9) / 16);
  const boxY = 214;
  const elements: DesignElement[] = [];
  elements.push({
    id: newElementId("v"), name: "Clip", type: "video", x: M, y: boxY, w: boxW, h: boxH, opacity: 1, locked: false,
    src: null, startSec: 0, endSec: 30, fit: "cover", radius: 28, crop: { ...DEFAULT_CROP }, slot: ai(args.clipHint), stack: null,
  });
  const pillW = 620;
  const pillX = Math.round((W - pillW) / 2);
  const pillY = boxY + boxH - 96;
  elements.push(rect("Pill", { x: pillX, y: pillY, w: pillW, h: 64 }, PILL_PURPLE, 14));
  elements.push(text("Pill label", { x: pillX, y: pillY, w: pillW, h: 64 }, [{ text: args.pillSample }], baseText({ fontId: "montserrat-extrabold", sizePx: 30, lineHeight: 1, color: "#FFFFFF", align: "center", valign: "middle", uppercase: true, autoFit: true, minSizePx: 16 }), { slot: ai(args.pillHint) }));
  if (args.captions) {
    elements.push({
      id: newElementId("c"), name: "Captions", type: "captions", x: 60, y: 60, w: W - 120, h: 130, opacity: 1, locked: false, maxWordsPerCue: 12,
      style: baseText({ fontId: "inter-regular", sizePx: 32, lineHeight: 1.25, color: "#5C5C5C", align: "center", valign: "middle", autoFit: true, minSizePx: 20 }),
      slot: null, stack: null,
    });
  }
  const titleY = boxY + boxH + 34;
  elements.push(text("Video title", { x: M, y: titleY, w: boxW - 190, h: 100 }, [{ text: args.titleSample }], baseText({ fontId: "inter-bold", sizePx: 40, lineHeight: 1.15, color: "#0F0F0F", align: "left", valign: "top", autoFit: true, minSizePx: 24 }), { slot: sys("videoTitle") }));
  elements.push(rect("YouTube badge", { x: W - M - 160, y: titleY + 2, w: 160, h: 46 }, "#FF0000", 10));
  elements.push(text("YouTube", { x: W - M - 160, y: titleY + 2, w: 160, h: 46 }, [{ text: "▶ YouTube" }], baseText({ fontId: "inter-bold", sizePx: 24, lineHeight: 1, color: "#FFFFFF", align: "center", valign: "middle" })));
  const rowY = titleY + 116;
  elements.push(channelElement({ x: M, y: rowY, w: 620, h: 68 }));
  elements.push({ id: newElementId("img"), name: "Wordmark", type: "image", x: W - M - 260, y: rowY + 6, w: 260, h: 60, opacity: 0.9, locked: false, src: WORDMARK_DARK, fit: "contain", radius: 0, crop: { ...DEFAULT_CROP }, slot: null, stack: null });
  return { id: newElementId("page"), background: "#FFFFFF", elements };
}

export { rect };
