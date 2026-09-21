/**
 * The channel element's geometry and text, shared by the stage and the
 * exporter: an avatar circle the height of the box, the name beside it,
 * the follower line under the name. Pure.
 */
import type { DesignChannelElement, DesignDoc, DesignTextElement } from "./doc";

/** What the element needs to know about the account — resolved by the
 *  session (preview) and the render task (export) from `accounts`. */
export interface ChannelInfo {
  accountId: string;
  platform: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  followerCount: number | null;
  verified: boolean;
}

export function formatFollowers(n: number | null, platform: string): string {
  if (!n || n <= 0) return "";
  const noun = platform === "youtube" ? "subscribers" : "followers";
  const num = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 < 50_000 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
  return `${num} ${noun}`;
}

export interface ChannelLayout {
  avatar: { x: number; y: number; d: number };
  name: DesignTextElement;
  followers: DesignTextElement | null;
  /** The initial drawn in the circle when there is no avatar picture. */
  initial: string;
}

export function layoutChannel(el: DesignChannelElement, info: ChannelInfo | null): ChannelLayout {
  const d = Math.round(el.h);
  const gap = Math.round(d * 0.24);
  const textX = el.x + d + gap;
  const textW = Math.max(40, el.w - d - gap);
  const ink = el.theme === "light" ? "#0F0F0F" : "#FFFFFF";
  const sub = el.theme === "light" ? "#606060" : "#C7C7CC";
  const name = info ? `${info.name}${info.verified ? " ✓" : ""}` : "Channel";
  const followersText = info ? formatFollowers(info.followerCount, info.platform) : "";
  const showFollowers = el.showFollowers && followersText.length > 0;
  const nameSize = Math.round(d * (showFollowers ? 0.41 : 0.44));
  const subSize = Math.round(d * 0.32);
  const base = { id: el.id, opacity: 1, locked: false, slot: null, stack: null } as const;
  const style = (sizePx: number, color: string, fontId: "inter-semibold" | "inter-regular") => ({
    fontId, sizePx, lineHeight: 1.2, letterSpacing: 0, color, align: "left" as const, valign: "middle" as const, uppercase: false, shadow: null, autoFit: true, minSizePx: 10,
  });
  const nameEl: DesignTextElement = {
    ...base, id: `${el.id}-name`, name: "Channel name", type: "text",
    x: textX, y: showFollowers ? el.y - Math.round(d * 0.03) : el.y, w: textW, h: showFollowers ? Math.round(d * 0.55) : d,
    spans: [{ text: name }], style: style(nameSize, ink, "inter-semibold"),
  };
  const followersEl: DesignTextElement | null = showFollowers
    ? { ...base, id: `${el.id}-followers`, name: "Followers", type: "text", x: textX, y: el.y + Math.round(d * 0.53), w: textW, h: Math.round(d * 0.45), spans: [{ text: followersText }], style: style(subSize, sub, "inter-regular") }
    : null;
  return { avatar: { x: el.x, y: el.y, d }, name: nameEl, followers: followersEl, initial: (info?.name ?? "S").slice(0, 1).toUpperCase() };
}

/** The account a channel element shows: its `accountId`, else the brand's
 *  biggest account on its `platform`. */
export function resolveChannel(el: DesignChannelElement, channels: ChannelInfo[]): ChannelInfo | null {
  if (el.accountId) {
    const byId = channels.find((c) => c.accountId === el.accountId);
    if (byId) return byId;
  }
  return channels.find((c) => c.platform === el.platform) ?? null;
}

export function resolveChannelsInDoc(doc: DesignDoc, channels: ChannelInfo[]): Record<string, ChannelInfo | null> {
  const out: Record<string, ChannelInfo | null> = {};
  for (const page of doc.pages) for (const el of page.elements) if (el.type === "channel") out[el.id] = resolveChannel(el, channels);
  return out;
}
