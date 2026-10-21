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

export interface NewsletterFormatConfig {
  kind: "roundup" | "single_video";
  /** single_video: the YouTube account (handle) whose videos feed this format. */
  sourceAccountHandle?: string;
  /** Model override; defaults to the drafter's Opus model. */
  model?: string;
  promo?: PromoCalendarConfig;
}

const STARTER_STORY_PROMO_PROJECT = "1213468297418521"; // MEDIA | Starter Story Promo Calendar
const FUTUREPEDIA_PROMO_PROJECT = "1213986172831893"; // MEDIA | Futurepedia Promo Calendar

/** Keyed by lowercase format name. Formats not listed are plain roundups. */
const FORMAT_CONFIG: Record<string, NewsletterFormatConfig> = {
  "sunday breakfast": {
    kind: "roundup",
    promo: { projectGid: STARTER_STORY_PROMO_PROJECT, section: "Native Ad", label: "The Special", onMiss: "agent" },
  },
  "how-to newsletter - futurepedia (pilot)": {
    kind: "single_video",
    sourceAccountHandle: "futurepedia_io",
    model: "claude-sonnet-5-5",
    promo: { projectGid: FUTUREPEDIA_PROMO_PROJECT, section: "Native Ad", label: "Free Resource", onMiss: "placeholder" },
  },
  "how-to newsletter - skill leap (pilot)": {
    kind: "single_video",
    sourceAccountHandle: "SkillLeapAI",
    model: "claude-sonnet-5-5",
    promo: { projectGid: FUTUREPEDIA_PROMO_PROJECT, section: "Native Ad", label: "Free Resource", onMiss: "placeholder" },
  },
};

const ROUNDUP: NewsletterFormatConfig = { kind: "roundup" };

export function formatConfigFor(formatName: string): NewsletterFormatConfig {
  return FORMAT_CONFIG[formatName.trim().toLowerCase()] ?? ROUNDUP;
}
