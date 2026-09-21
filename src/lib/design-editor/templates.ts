/**
 * Presets: the built-in format templates a format owner can start from
 * (the formats page → "Create template"), and the default preset for a
 * format that has no stored template yet — so the queue works for those
 * formats before anyone has visited the formats page.
 * Pure and client-safe; the server reads it too.
 */
import type { DesignDoc } from "./doc";
import { buildPlaybookTemplate } from "./playbook-template";
import { buildTechStackTemplate } from "./tech-stack-template";
import { buildStoryTemplate } from "./story-template";
import { buildTmzTemplate } from "./tmz-template";
import { buildAppsTemplate } from "./apps-template";

export type DesignPresetId = "playbook" | "tech-stack" | "story" | "tmz" | "apps" | "blank";

export const DESIGN_PRESETS: Record<DesignPresetId, { label: string; description: string; build: () => DesignDoc }> = {
  playbook: { label: "Playbook", description: "Photo + stat + headline, iOS Notes playbook, a clip as a YouTube card, a comment-to-DM CTA.", build: buildPlaybookTemplate },
  "tech-stack": { label: "Tech Stack", description: "Photo cover with a plain headline, the stack as a Notes list, a clip, a comment-to-DM CTA.", build: buildTechStackTemplate },
  story: { label: "Full Story", description: "Photo cover with an all-caps headline, up to 9 story beats over stills of the video, a sign-off slide.", build: buildStoryTemplate },
  tmz: { label: "TMZ", description: "One 4:5 image: the founder over a black band with a first-person quote in condensed caps.", build: buildTmzTemplate },
  apps: { label: "What My Apps Do", description: "4:5 photo cover, then one Notes page per app: name, result, three bullets, a screenshot card.", build: buildAppsTemplate },
  blank: {
    label: "Blank",
    description: "One empty square page.",
    build: () => ({ version: 1, canvas: { width: 1080, height: 1080 }, template: "blank", pages: [{ id: "page-1", background: "#0B0B0B", elements: [] }] }),
  },
};

/** Formats that get a preset automatically until they store their own. */
export const DEFAULT_PRESET_FOR_FORMAT: Record<string, DesignPresetId> = {
  "Instagram PLAYBOOK": "playbook",
  "Tech Stack Slideshow": "tech-stack",
  "Full Story Slideshow (IG)": "story",
  "TMZ": "tmz",
  "What My Apps Are & What They Do": "apps",
};

export function isDesignPresetId(v: unknown): v is DesignPresetId {
  return typeof v === "string" && v in DESIGN_PRESETS;
}
