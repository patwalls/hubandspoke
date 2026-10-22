// Per-format behavior for the newsletter drafter. Pure data, no imports, so
// the page (client) and the worker read the same config.
//
// - roundup:       the agent searches a lookback window (videos + case
//                  studies) and picks its own sources (Sunday Breakfast,
//                  Daily Seinfeld).
// - single_video:  one video in, one issue out (the Futurepedia / Skill Leap
//                  How-To, ported from the Claude-skill workflow). The editor
//                  picks the video; the agent writes only from its transcript.
//
// `promo` = the sponsored section is pulled from an Asana promo calendar (see
// promo.ts). `onMiss` decides what happens when no task is due on the send
// date: "agent" lets the agent fill the section itself (a lead magnet);
// "placeholder" makes it write a complete, clearly marked placeholder so a
// missing sponsor can't slip into a send unnoticed.

export interface PromoCalendarConfig {
  projectGid: string;
  section: string;
  /** What the sponsored section is called in this newsletter. */
  label: string;
  onMiss: "agent" | "placeholder";
}

/**
 * When issues go out. Every format in the same `group` shares one slot per
 * send date (the How-To is one Tuesday newsletter whose source video can come
 * from either channel); slots are created on the group's `primary` format and
 * move to the sibling format when a video from its channel is picked.
 */
export interface NewsletterSchedule {
  group: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  primary?: boolean;
  /**
   * single_video groups: editions are queued per published video, not per
   * day. "video" = the slots sweep queues them (pilot); "queue" = the regular
   * queue's threshold sweep creates a production item per video (pillar = the
   * video) with its linked edition (newsletter-queue.ts). Either way the send
   * date is the next open `days` day, or — when that week's `days` are taken —
   * the next weekday, up to `maxPerWeek` per Mon–Sun week (videoSendDate). No
   * empty slots are made ahead.
   */
  trigger?: { kind: "video" | "queue"; maxPerWeek: number };
}

export interface NewsletterFormatConfig {
  kind: "roundup" | "single_video";
  schedule?: NewsletterSchedule;
  /**
   * single_video: the YouTube channels whose videos feed this format, each
   * with the voice its editions are written in (and the beehiiv author they're
   * posted under) — the edition's VIDEO picks the voice, not the format.
   */
  sources?: { handle: string; voice: "kevin" | "saj"; voiceName: string }[];
  /** Model override; defaults to the drafter's Opus model. */
  model?: string;
  promo?: PromoCalendarConfig;
}

/**
 * Brands whose case studies the drafter can search (Starter Story's content
 * API). Other brands' roundups draw on their own videos only, and the template
 * editor hides the case-study story option for them.
 */
const CASE_STUDY_BRANDS = new Set(["starter-story"]);
export function brandHasCaseStudies(brand: string): boolean {
  return CASE_STUDY_BRANDS.has(brand);
}

/**
 * Paid runs (draft, regenerate, Find new story) wait this long in the queue
 * before the first model call, so Cancel right after a mis-click costs nothing.
 */
export const NEWSLETTER_START_DELAY_MS = 10_000;

const STARTER_STORY_PROMO_PROJECT = "1213468297418521"; // MEDIA | Starter Story Promo Calendar
const FUTUREPEDIA_PROMO_PROJECT = "1213986172831893"; // MEDIA | Futurepedia Promo Calendar

const FUTUREPEDIA_SOURCES: NonNullable<NewsletterFormatConfig["sources"]> = [
  { handle: "futurepedia_io", voice: "kevin", voiceName: "Kevin" },
  { handle: "SkillLeapAI", voice: "saj", voiceName: "Saj" },
];

/** Keyed by lowercase format name. Formats not listed are plain roundups. */
const FORMAT_CONFIG: Record<string, NewsletterFormatConfig> = {
  "daily seinfeld": {
    kind: "roundup",
    schedule: { group: "daily-seinfeld", days: [2, 4], primary: true },
  },
  "sunday breakfast": {
    kind: "roundup",
    schedule: { group: "sunday-breakfast", days: [0], primary: true },
    promo: { projectGid: STARTER_STORY_PROMO_PROJECT, section: "Native Ad", label: "The Special", onMiss: "agent" },
  },
  // ONE How-To newsletter for both channels (Sam, 2026-10-21): the video's
  // channel picks Kevin's or Saj's voice + beehiiv author. Ideas land in the
  // regular queue when a video is published (root format, trigger sources =
  // both channels, view threshold 1).
  "futurepedia newsletter": {
    kind: "single_video",
    sources: FUTUREPEDIA_SOURCES,
    // Usually Tue/Fri, ≤3 a week (Bryce + Sam, 2026-10-21). Group name kept so the history carries over.
    schedule: { group: "futurepedia-howto", days: [2, 5], primary: true, trigger: { kind: "queue", maxPerWeek: 3 } },
    model: "claude-sonnet-5-5",
    promo: { projectGid: FUTUREPEDIA_PROMO_PROJECT, section: "Native Ad", label: "Free Resource", onMiss: "placeholder" },
  },
};

const ROUNDUP: NewsletterFormatConfig = { kind: "roundup" };

export function formatConfigFor(formatName: string): NewsletterFormatConfig {
  return FORMAT_CONFIG[formatName.trim().toLowerCase()] ?? ROUNDUP;
}

/** Lowercase names of every format in a schedule group. */
export function groupFormatNames(group: string): string[] {
  return Object.entries(FORMAT_CONFIG)
    .filter(([, c]) => c.schedule?.group === group)
    .map(([name]) => name);
}

/** Every scheduled group's primary format name (lowercase) + its schedule. */
export function scheduledPrimaries(): Array<{ formatName: string; schedule: NewsletterSchedule }> {
  return Object.entries(FORMAT_CONFIG)
    .filter(([, c]) => c.schedule?.primary)
    .map(([formatName, c]) => ({ formatName, schedule: c.schedule! }));
}

/** Upcoming send dates (YYYY-MM-DD, UTC calendar days) on `days`, from tomorrow through `horizonDays` ahead. Pure. */
export function upcomingSendDates(days: number[], horizonDays: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = 1; i <= horizonDays; i++) {
    const d = new Date(base + i * 24 * 60 * 60 * 1000);
    if (days.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * single_video formats: where each issue's one video comes from, in words for
 * the template editor (the slots sweep deals it; the issue's video picker
 * overrides it). Null for roundups.
 */
export function singleVideoSourceNote(formatName: string): string | null {
  const c = formatConfigFor(formatName);
  if (c.kind !== "single_video") return null;
  const handles = (c.sources ?? []).map((x) => x.handle);
  const from = handles.length ? handles.map((h) => `@${h}`).join(" or ") : "this format's channel";
  return `Each issue is written from ONE video: by default the newest published long-form video from ${from} that no other issue is using (switch it in the issue's video picker). Its channel picks the voice (${(c.sources ?? []).map((x) => `@${x.handle} → ${x.voiceName}`).join(", ")}). Sections don't pick their own stories; the rules come from the format's Skill and each section's instructions.`;
}

/** The voice for a video from `handle` in a single_video format, else null. */
export function voiceForChannel(formatName: string, handle: string | null | undefined): { voice: "kevin" | "saj"; voiceName: string } | null {
  if (!handle) return null;
  const src = formatConfigFor(formatName).sources?.find((x) => x.handle.toLowerCase() === handle.toLowerCase());
  return src ? { voice: src.voice, voiceName: src.voiceName } : null;
}
