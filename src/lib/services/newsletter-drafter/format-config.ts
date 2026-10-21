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
}

/** Roundups: which template sections get which kind of story (see story-plan.ts). */
export interface StoryPlanConfig {
  /** Sections that take the week's newest videos, in order (newest first). */
  leadVideos: string[];
  /** Sections that take the week's case studies (newest first), else a recent video. */
  flex: string[];
}

export interface NewsletterFormatConfig {
  kind: "roundup" | "single_video";
  schedule?: NewsletterSchedule;
  /** single_video: the YouTube account (handle) whose videos feed this format. */
  sourceAccountHandle?: string;
  /** Model override; defaults to the drafter's Opus model. */
  model?: string;
  promo?: PromoCalendarConfig;
  storyPlan?: StoryPlanConfig;
}

/**
 * Paid runs (draft, regenerate, Find new story) wait this long in the queue
 * before the first model call, so Cancel right after a mis-click costs nothing.
 */
export const NEWSLETTER_START_DELAY_MS = 10_000;

const STARTER_STORY_PROMO_PROJECT = "1213468297418521"; // MEDIA | Starter Story Promo Calendar
const FUTUREPEDIA_PROMO_PROJECT = "1213986172831893"; // MEDIA | Futurepedia Promo Calendar

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
    storyPlan: { leadVideos: ["orange_juice", "coffee"], flex: ["eggs", "toast", "pancakes"] },
  },
  "how-to newsletter - futurepedia (pilot)": {
    kind: "single_video",
    sourceAccountHandle: "futurepedia_io",
    schedule: { group: "futurepedia-howto", days: [2], primary: true },
    model: "claude-sonnet-5-5",
    promo: { projectGid: FUTUREPEDIA_PROMO_PROJECT, section: "Native Ad", label: "Free Resource", onMiss: "placeholder" },
  },
  "how-to newsletter - skill leap (pilot)": {
    kind: "single_video",
    sourceAccountHandle: "SkillLeapAI",
    schedule: { group: "futurepedia-howto", days: [2] },
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
