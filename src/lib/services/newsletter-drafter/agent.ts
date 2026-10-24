// The newsletter drafter's agent loop. One run per draft: the model gathers
// its material through tools (roundups: the window's published videos and
// their transcripts, recent starterstory.com case studies via the content API
// + web_fetch, the lead-magnet catalog; single-video How-Tos: just the
// transcript in the prompt), writes the issue in the format Skill's voice,
// and submits it through `submit_newsletter` — one Markdown block per
// template section when the format has a template (newsletter-template.ts),
// else one free-form body. A second pass then reviews the submission against
// the Skill and past issues and submits the revised version — the "Claude
// reviews its own draft" step of the original Claude-skill workflow, folded
// into the same conversation so the cached prompt is reused.
//
// `regenerateSection` reuses the same loop to rewrite ONE section of an
// existing issue (the editor's per-section Regenerate), with the editor's
// optional instruction, and submits it through `submit_section`.
//
// Manual loop (not the SDK tool runner) because the run has two phases keyed
// off a client tool, needs `pause_turn` resumption for web_fetch, and must
// stop on refusal / max_tokens instead of looping.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { NewsletterSection, NewsletterTemplate } from "@/lib/newsletter-template";
import { listLeadMagnets } from "@/lib/services/starter-story-content";
import { describeStoryPlan, newStoryGuidance, type StoryPlan } from "./story-plan";
import { describeSectionExamples } from "./exemplars";
import { brandHasCaseStudies } from "./format-config";
import { getTimestampedTranscript, getVideoTranscript, listOlderVideos, listRecentCaseStudies, listRecentVideos, searchCaseStudies, TRANSCRIPT_CHAR_BUDGET, type PastIssue } from "./sources";
import { caseStudyKey, EVERGREEN_MIN_DAYS, isEvergreenOk, RECENT_BLOCK_DAYS, type StoryUsage } from "./usage";
import { SPECIAL_MARKER } from "./special-compose";
import { toolWindow, type DraftWindow } from "./window";

export const NEWSLETTER_MODEL = "claude-opus-5-5";

/**
 * The model a run uses: `NEWSLETTER_MODEL_OVERRIDE` (Heroku config — a cheaper
 * model while testing features; unset it to go back) beats the format's own
 * model (format-config.ts), which beats NEWSLETTER_MODEL.
 */
export function newsletterModel(formatModel?: string | null): string {
  return process.env.NEWSLETTER_MODEL_OVERRIDE?.trim() || formatModel || NEWSLETTER_MODEL;
}
const MAX_TURNS = 30;
const MAX_TOKENS = 32_000;
/** Per-turn ceiling for one non-streaming call (a long write turn + thinking). */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const CASE_STUDY_SITE = "https://www.starterstory.com/explore";

const DaysInput = z.object({ days: z.number().int().min(1).max(31).nullable().optional() });
const TranscriptInput = z.object({ production_item_id: z.string().uuid() });
const SourceInput = z.object({
  kind: z.enum(["video", "case_study"]),
  production_item_id: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});
const SectionInput = z.object({ key: z.string().min(1), markdown: z.string(), source: SourceInput.nullable().optional() });
const SubmitInput = z.object({
  subject_options: z.array(z.string().min(1).max(120)).min(3).max(6),
  subject: z.string().min(1).max(120),
  preview_text: z.string().max(200),
  body_markdown: z.string().optional(),
  sections: z.array(SectionInput).optional(),
  sources: z
    .array(
      z.object({
        kind: z.enum(["video", "case_study"]),
        production_item_id: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
        title: z.string().nullable().optional(),
      }),
    )
    .max(30),
});
export type NewsletterSubmission = z.infer<typeof SubmitInput>;
const SubmitSectionInput = z.object({ markdown: z.string().min(1), source: SourceInput.nullable().optional() });
export type SourceInputT = z.infer<typeof SourceInput>;

/** The usage key for a declared story ("video:<id>" / "case:<path>"), or null. Pure; exported for tests. */
export function storyKeyOf(src: SourceInputT | null | undefined): string | null {
  if (!src) return null;
  if (src.kind === "video") return src.production_item_id ? `video:${src.production_item_id}` : null;
  return caseStudyKey(src.url);
}

const DAYS_SCHEMA = {
  type: "object" as const,
  properties: {
    days: {
      type: ["integer", "null"],
      description: "Lookback in days ending at the draft's end date. Omit/null to use the draft's window.",
    },
  },
};

const SOURCE_TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "list_recent_videos",
    description:
      "List the brand's published long-form YouTube videos in the window, newest first, with views and whether a transcript is available.",
    input_schema: DAYS_SCHEMA,
  },
  {
    name: "get_video_transcript",
    description: "Full transcript of one video from list_recent_videos (may be truncated for very long videos).",
    input_schema: {
      type: "object",
      properties: { production_item_id: { type: "string" } },
      required: ["production_item_id"],
    },
  },
  {
    name: "list_recent_case_studies",
    description:
      "List Starter Story case studies (founder interviews + breakdowns) published on starterstory.com in the window: title, URL, summary, business. Use web_fetch on a URL to read the full case study.",
    input_schema: DAYS_SCHEMA,
  },
  {
    name: "list_older_videos",
    description: `The brand's OLDER published long-form videos (before the window), most-viewed first, for when this week doesn't have enough new stories. Only returns ones this newsletter hasn't run in the last ${EVERGREEN_MIN_DAYS} days.`,
    input_schema: { type: "object", properties: { limit: { type: ["integer", "null"], description: "How many (default 15, max 30)." } } },
  },
  {
    name: "search_case_studies",
    description: `Search ALL Starter Story case studies (interviews + breakdowns) by topic, business or founder, e.g. "AI app", "ecommerce", "newsletter". For when this week doesn't have enough new case studies. Each result says when this newsletter last ran it; anything run in the last ${RECENT_BLOCK_DAYS} days is blocked.`,
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "list_lead_magnets",
    description: "Starter Story's lead magnets (free guides/tools) with landing-page URLs, for CTAs when the Skill calls for one.",
    input_schema: { type: "object", properties: {} },
  },
  {
    type: "web_fetch_20260209",
    name: "web_fetch",
    allowed_domains: ["starterstory.com"],
    max_uses: 12,
  },
];

/** Tools that read Starter Story's site / APIs (case studies, lead magnets, page fetches). */
const STARTER_STORY_TOOLS = new Set(["list_recent_case_studies", "search_case_studies", "list_lead_magnets", "web_fetch"]);

/** The source tools for a brand: brands without case studies get their own videos only. */
export function sourceToolsFor(brand: string): Anthropic.Beta.BetaToolUnion[] {
  return brandHasCaseStudies(brand) ? SOURCE_TOOLS : SOURCE_TOOLS.filter((t) => !("name" in t && STARTER_STORY_TOOLS.has(t.name)));
}

const SOURCES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["video", "case_study"] },
      production_item_id: { type: ["string", "null"] },
      url: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
    },
    required: ["kind"],
  },
};

function submitNewsletterTool(templated: boolean): Anthropic.Beta.BetaToolUnion {
  return {
    name: "submit_newsletter",
    description: templated
      ? "Submit the finished issue: one Markdown block per template section (every key, in template order; don't repeat a section's fixed heading inside its markdown). sources lists every video/case study the issue draws on."
      : "Submit the finished issue. body_markdown is the full email body in Markdown (headings, links, lists). sources lists every video/case study the issue draws on.",
    input_schema: {
      type: "object",
      properties: {
        subject_options: { type: "array", items: { type: "string" }, description: "3-6 distinct subject lines, best first." },
        subject: { type: "string", description: "The chosen subject line (normally subject_options[0])." },
        preview_text: { type: "string", description: "Inbox preview text." },
        ...(templated
          ? {
              sections: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    markdown: { type: "string" },
                    source: {
                      type: ["object", "null"],
                      description: "The ONE video or case study this section covers (null for sections that don't cover a story, e.g. intro, sign-off, sponsor).",
                      properties: {
                        kind: { type: "string", enum: ["video", "case_study"] },
                        production_item_id: { type: ["string", "null"] },
                        url: { type: ["string", "null"] },
                        title: { type: ["string", "null"] },
                      },
                      required: ["kind"],
                    },
                  },
                  required: ["key", "markdown"],
                },
              },
            }
          : { body_markdown: { type: "string" } }),
        sources: SOURCES_SCHEMA,
      },
      required: ["subject_options", "subject", "preview_text", templated ? "sections" : "body_markdown", "sources"],
    },
  };
}

const SUBMIT_SECTION_TOOL: Anthropic.Beta.BetaToolUnion = {
  name: "submit_section",
  description: "Submit the rewritten section's Markdown (content only; its fixed heading, if any, is added for you), and the story it covers.",
  input_schema: {
    type: "object",
    properties: {
      markdown: { type: "string" },
      source: {
        type: ["object", "null"],
        properties: {
          kind: { type: "string", enum: ["video", "case_study"] },
          production_item_id: { type: ["string", "null"] },
          url: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
        },
        required: ["kind"],
      },
    },
    required: ["markdown"],
  },
};

export interface NewsletterAgentArgs {
  brand: string;
  brandLabel: string;
  brandGuidelines: string | null;
  formatName: string;
  formatInstructions: string | null;
  pastIssues: PastIssue[];
  window: DraftWindow;
  /** The issue's sections. When set the agent submits one block per section. */
  template?: NewsletterTemplate | null;
  /** Editor steer for this issue (e.g. the offer to pitch). */
  notes?: string | null;
  /** YYYY-MM-DD the issue goes out. */
  sendDate?: string | null;
  /** The sponsored section's copy from the promo calendar. When set the agent
   *  doesn't write that section (templated: leaves it empty; free-form: leaves
   *  SPECIAL_MARKER) — the copy is inserted afterwards. */
  sponsoredCopy?: string | null;
  /** The sponsor's landing page (the How-To's intro teaser links to it too). */
  sponsoredLandingUrl?: string | null;
  /** What the sponsored section is called ("The Special", "Free Resource"). */
  specialLabel?: string | null;
  /** No promo matched and the format wants a marked placeholder instead of the agent's own pick. */
  sponsoredPlaceholder?: boolean;
  /** single_video formats: the one video this issue is written from. When set
   *  the agent gets only the submit tool — no search, no web. */
  video?: SourceVideo | null;
  /**
   * A roundup issue about ONE piece of pillar content (the editor picked it):
   * the video + transcript go in the first turn and every story section draws
   * on it; the tools stay for supporting material.
   */
  pillar?: SourceVideo | null;
  /** The format's model (format-config.ts); see newsletterModel() for the full order. */
  model?: string;
  /** Story usage for this newsletter (key → times run / last date), excluding this draft. */
  usage?: Map<string, StoryUsage>;
  /** Story keys run in the last RECENT_BLOCK_DAYS — never usable. */
  blocked?: Set<string>;
  /** Roundups with a story plan (story-plan.ts): the suggested lineup, given to the agent (not enforced). */
  storyPlan?: StoryPlan | null;
  /** single_video: this newsletter's recent editions (newest first), so the drafter picks a fresh task. */
  recentEditions?: { date: string | null; subject: string }[];
  /** How each template section has read in past issues (exemplars.ts), by section key: examples next to the instructions. */
  sectionExamples?: Record<string, string[]> | null;
  /** Checked before every model call; true = the editor cancelled, stop (throws NewsletterCancelledError). */
  shouldStop?: () => Promise<boolean>;
  /** Worker logger, e.g. helpers.logger.info: one line per turn with the tools called. */
  log?: (msg: string) => void;
  /** Called after each model turn with where the run is (the editor's progress bar). Errors are ignored. */
  onProgress?: (p: { phase: DraftPhase; turn: number; detail: string | null }) => Promise<void> | void;
  signal?: AbortSignal;
  client?: Anthropic;
}

export type DraftPhase = "gathering" | "reading" | "writing" | "reviewing";

/**
 * Where a run is after a turn, from the tools it just called: listing stories
 * → gathering, transcripts / page fetches → reading, the first submit →
 * reviewing (the self-review pass), a turn with no tools → writing. Pure;
 * exported for tests.
 */
export function phaseFor(tools: string[], reviewing: boolean): { phase: DraftPhase; detail: string | null } {
  const n = (name: string) => tools.filter((t) => t === name).length;
  if (tools.some((t) => t.startsWith("submit_"))) return { phase: "reviewing", detail: reviewing ? "Final pass" : "Reviewing its own draft" };
  if (reviewing) return { phase: "reviewing", detail: "Revising" };
  const reads = n("get_video_transcript") + n("web_fetch");
  if (reads) {
    const parts = [n("get_video_transcript") && `${n("get_video_transcript")} transcript${n("get_video_transcript") > 1 ? "s" : ""}`, n("web_fetch") && `${n("web_fetch")} page${n("web_fetch") > 1 ? "s" : ""}`].filter(Boolean);
    return { phase: "reading", detail: `Reading ${parts.join(" and ")}` };
  }
  if (tools.length) return { phase: "gathering", detail: "Finding stories" };
  return { phase: "writing", detail: "Writing" };
}

export interface SourceVideo {
  productionItemId: string;
  /** The channel it's on; with the format's sources this picks the voice (Kevin / Saj). */
  channelHandle?: string | null;
  /** The voice this edition is written in, from the video's channel (one-format newsletters). */
  voiceName?: string | null;
  title: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  transcript: string;
  truncated: boolean;
  /** Each transcript line starts with its [M:SS] timestamp. */
  timestamped?: boolean;
}

export interface NewsletterAgentResult {
  submission: NewsletterSubmission;
  model: string;
  turns: number;
}

export class NewsletterAgentError extends Error {}

/** The editor cancelled the run (no more model calls; nothing is written). */
export class NewsletterCancelledError extends Error {}

function buildSystem(args: NewsletterAgentArgs): Anthropic.Beta.BetaTextBlockParam[] {
  const role = (
    args.video
      ? [
          `You write the ${args.brandLabel} newsletter "${args.formatName}".`,
          "You draft one complete issue from ONE video, which an editor will review, then send from their email tool.",
          "The video's transcript is in the first message. Every feature, button, setting, prompt pattern, price, limit and result you mention must come from that transcript. You design the scenario and the steps; you never invent capabilities. Where a detail is missing, keep it general. Never invent links.",
          "Follow the format Skill below exactly: it owns voice, length and house rules. The issue template in the first message owns the section list.",
          "Write in Markdown.",
        ]
      : [
          `You write the ${args.brandLabel} newsletter "${args.formatName}".`,
          "You draft one complete issue that an editor will review, then send from their email tool.",
          brandHasCaseStudies(args.brand)
            ? "Gather your own material with the tools: the brand's videos published in the window (read the transcripts of the ones you use) and recent case studies on starterstory.com (read the full page with web_fetch before writing about one). Never invent facts, numbers, quotes or links — everything in the issue must come from a transcript, a fetched page, or the lead-magnet list."
            : "Gather your own material with the tools: the brand's videos published in the window (read the transcripts of the ones you use). Never invent facts, numbers, quotes or links — everything in the issue must come from a transcript.",
          "Follow the format Skill below exactly when it says how far back to look, what to include, length and CTA rules. Where the Skill is silent, match the past issues.",
          "Write in Markdown. Link every video and case study you mention with its real URL.",
        ]
  ).join("\n");

  const context: string[] = [];
  if (args.brandGuidelines?.trim()) context.push(`## BRAND GUIDELINES\n${args.brandGuidelines.trim()}`);
  context.push(
    `## FORMAT SKILL — ${args.formatName}\n${args.formatInstructions?.trim() || "(No Skill written yet — follow the past issues closely.)"}`,
  );
  if (args.template?.styleNotes?.trim()) {
    const learned = args.template.learnedFrom ? ` (learned from ${args.template.learnedFrom} past issues${args.template.learnedAt ? `, ${args.template.learnedAt.slice(0, 10)}` : ""})` : "";
    context.push(`## HOW THIS NEWSLETTER READS${learned}\n${args.template.styleNotes.trim()}`);
  }
  if (args.pastIssues.length > 0) {
    const issues = args.pastIssues
      .map(
        (p, i) =>
          `### Past issue ${i + 1}${p.publishedAt ? ` (${p.publishedAt.slice(0, 10)})` : ""}\nSubject: ${p.subject ?? ""}\nPreview: ${p.previewText ?? ""}\n\n${p.body}`,
      )
      .join("\n\n---\n\n");
    context.push(`## PAST ISSUES (voice + structure reference — do not reuse their content)\n${issues}`);
  }

  return [
    { type: "text", text: role },
    { type: "text", text: context.join("\n\n"), cache_control: { type: "ephemeral" } },
  ];
}

/** Usage fields every story in a tool result carries. */
function usageFields(key: string | null, args: NewsletterAgentArgs) {
  const u = key ? args.usage?.get(key) : undefined;
  return {
    story_key: key,
    times_run_in_this_newsletter: u?.count ?? 0,
    last_run: u?.lastDate ?? null,
    blocked: key ? (args.blocked?.has(key) ?? false) : false,
  };
}

async function runClientTool(name: string, input: unknown, args: NewsletterAgentArgs): Promise<string> {
  switch (name) {
    case "list_recent_videos": {
      const { days } = DaysInput.parse(input ?? {});
      const w = toolWindow(args.window, days);
      const videos = (await listRecentVideos(args.brand, w)).map((v) => ({ ...v, ...usageFields(`video:${v.productionItemId}`, args) }));
      return JSON.stringify({ window: { start: w.start.toISOString(), end: w.end.toISOString() }, videos });
    }
    case "list_older_videos": {
      const { limit } = z.object({ limit: z.number().int().min(1).max(30).nullable().optional() }).parse(input ?? {});
      const older = (await listOlderVideos(args.brand, args.window.start, 120))
        .filter((v) => isEvergreenOk(args.usage?.get(`video:${v.productionItemId}`)) && !args.blocked?.has(`video:${v.productionItemId}`))
        .slice(0, limit ?? 15)
        .map((v) => ({ ...v, ...usageFields(`video:${v.productionItemId}`, args) }));
      return JSON.stringify({ videos: older });
    }
    case "search_case_studies": {
      const { query } = z.object({ query: z.string().min(2).max(100) }).parse(input);
      const found = (await searchCaseStudies(query)).map((c) => ({ ...c, ...usageFields(caseStudyKey(c.url), args) }));
      return JSON.stringify({ case_studies: found });
    }
    case "get_video_transcript": {
      const { production_item_id } = TranscriptInput.parse(input);
      // Screenshot sections need the moment each screen is on camera: [M:SS] per line.
      const t = wantsScreenshots(args.template) ? await getTimestampedTranscript(production_item_id, TRANSCRIPT_CHAR_BUDGET) : await getVideoTranscript(production_item_id);
      if (!t) return "No transcript is available for this video.";
      const note = "timestamped" in t && t.timestamped ? "(each line starts with its [M:SS] timestamp in the video)\n" : "";
      return `${note}${t.text}${t.truncated ? "\n\n[transcript truncated]" : ""}`;
    }
    case "list_recent_case_studies": {
      const { days } = DaysInput.parse(input ?? {});
      const w = toolWindow(args.window, days);
      const studies = (await listRecentCaseStudies(w)).map((c) => ({ ...c, ...usageFields(caseStudyKey(c.url), args) }));
      return JSON.stringify({ window: { start: w.start.toISOString(), end: w.end.toISOString() }, case_studies: studies });
    }
    case "list_lead_magnets": {
      const magnets = await listLeadMagnets();
      return JSON.stringify(magnets.map((m) => ({ title: m.title, url: m.url, description: m.description })));
    }
    default:
      throw new NewsletterAgentError(`unknown tool ${name}`);
  }
}

const REVIEW_PROMPT =
  "Draft received. Now review it critically against the format Skill (including any review checklist it contains) and the past issues: voice, structure, length, subject line quality, factual accuracy against the sources you read, and that every link is real. Fix anything that falls short, then call submit_newsletter again with the complete revised issue (all fields, not a diff).";

export const STORY_RULES = `STORY RULES (enforced — a submission that breaks them is rejected):
- Every video and case study in the tool results carries times_run_in_this_newsletter, last_run and blocked. NEVER use a story marked blocked: it ran in this newsletter in the last ${RECENT_BLOCK_DAYS} days (e.g. a video that went out last Sunday morning is still inside this week's lookback).
- Prefer this window's stories that haven't run before.
- If the window doesn't have enough usable stories, fill the rest with OLDER ones: list_older_videos and search_case_studies only return stories not run in the last ${EVERGREEN_MIN_DAYS} days.
- Never use the same story in two sections of one issue.
- For every section that covers a video or case study, set its source (kind + production_item_id for a video, kind + url for a case study, + title).`;

/** The template asks for screenshots in at least one section (any newsletter, set per section). */
export function wantsScreenshots(template: NewsletterTemplate | null | undefined): boolean {
  return !!template?.sections.some((sec) => sec.kind !== "sponsor" && sec.screenshots);
}

/**
 * How to mark a screenshot (sections whose template setting asks for them).
 * Hub & Spoke grabs the frame at that moment from the section's video and
 * shows it in the editor, where the editor can swap it. Exported for tests.
 */
export const SCREENSHOT_RULE = `SCREENSHOT RULE (sections marked "SCREENSHOTS" below): wherever a screenshot helps the reader, put a placeholder on its own line as *[Screenshot @ M:SS: what the screen shows]*. M:SS is the moment in the section's video (this issue's video, or the section's story video in a roundup — read its timestamped transcript with get_video_transcript) when that screen is on camera: the thing being shown, not when it's first mentioned. Hub & Spoke grabs that frame, so pick a moment it is visible. No video for the section (a case study)? Leave screenshots out of that section.`;

/** Sections marked THUMBNAIL show their video's thumbnail (any newsletter, set per section). Exported for tests. */
export const THUMBNAIL_RULE = `THUMBNAIL RULE (sections marked "THUMBNAIL" below): put the section's video thumbnail on its own line as a Markdown image ![<the video's title>](<thumbnail URL>), where the section's instructions place it. The URL is this issue's video's THUMBNAIL URL, or in a roundup the section's story video's thumbnail_url from the video tools. Never invent a URL: no video (a case study) means no thumbnail.`;

/**
 * How the template is framed for the drafter: the instructions say WHAT goes
 * in a section; the examples (past issues, exemplars.ts) show HOW it reads.
 * Variation is wanted — a newsletter, not a form. Exported for tests.
 */
export const TEMPLATE_FRAMING =
  "Each section's instructions say what goes there; its EXAMPLES (how that section read in past issues) show the voice, rhythm and shape — learn from the examples first, and let the instructions fill in what the examples don't show. Vary length, structure and rhythm the way the past issues do: a section can be one punchy paragraph in one issue and a short list in the next; never force every section into the same beat or the same length, and never copy an example's content. A section marked OPTIONAL may be submitted as an empty string when there's nothing worth saying in it this issue.";

/** The template block of the first user turn. Exported for tests. */
export function describeTemplate(template: NewsletterTemplate, sponsorSupplied: boolean, examples?: Record<string, string[]> | null): string {
  const lines = template.sections.map((sec, i) => {
    const heading = sec.heading ? `fixed heading "${sec.heading}" (added for you; don't repeat it)` : "no fixed heading (write your own if the section needs one)";
    const sponsor =
      sec.kind === "sponsor" && sponsorSupplied ? " — SUPPLIED BY THE PROMO CALENDAR: submit an empty string for this key" : "";
    const optional = sec.optional && sec.kind !== "sponsor" ? " — OPTIONAL" : "";
    const shots = sec.kind !== "sponsor" && sec.screenshots ? "\n   SCREENSHOTS: add screenshot placeholders here (SCREENSHOT RULE)." : "";
    const thumb = sec.kind !== "sponsor" && sec.thumbnail ? "\n   THUMBNAIL: include the video thumbnail here (THUMBNAIL RULE)." : "";
    const ex = sec.kind === "sponsor" && sponsorSupplied ? null : describeSectionExamples(examples?.[sec.key]);
    return `${i + 1}. key "${sec.key}" — ${heading}${sponsor}${optional}\n   ${sec.hint}${shots}${thumb}${ex ? `\n${ex}` : ""}`;
  });
  const rules = [wantsScreenshots(template) ? SCREENSHOT_RULE : null, template.sections.some((s) => s.kind !== "sponsor" && s.thumbnail) ? THUMBNAIL_RULE : null].filter(Boolean);
  const framing = examples && Object.keys(examples).length ? `${TEMPLATE_FRAMING}\n\n` : template.sections.some((s) => s.optional) ? "A section marked OPTIONAL may be submitted as an empty string when there's nothing worth saying in it this issue.\n\n" : "";
  return `${rules.map((r) => `${r}\n\n`).join("")}${framing}ISSUE TEMPLATE — submit exactly these sections, every key, in this order (sections[].key / sections[].markdown):\n${lines.join("\n")}`;
}

/** A roundup issue about one piece of pillar content: the block of the first turn. Exported for tests. */
export function describePillar(v: SourceVideo): string {
  return [
    `THIS ISSUE IS ABOUT ONE PIECE OF PILLAR CONTENT — the editor picked it. Every story section draws on this video (a different angle, lesson, moment or number in each; the lead section carries the main story), not on other stories. Link it with its URL; set each story section's source to it (the same source in several sections is right here). Use the tools only for supporting material the video calls for (a lead magnet, a case study it mentions).`,
    [
      `VIDEO: "${v.title ?? "Untitled"}"`,
      `URL: ${v.url ?? "(none)"}`,
      v.thumbnailUrl ? `THUMBNAIL URL (for sections marked THUMBNAIL): ${v.thumbnailUrl}` : null,
      v.publishedAt ? `Published: ${v.publishedAt.slice(0, 10)}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    `TRANSCRIPT${v.truncated ? " (truncated — very long video)" : ""}${v.timestamped ? " (each line starts with its [M:SS] timestamp in the video)" : ""}:\n${v.transcript}`,
  ].join("\n\n");
}

/** The first user turn. Exported for tests. */
export function buildUserTurn(args: NewsletterAgentArgs): string {
  const today = args.window.end.toISOString().slice(0, 10);
  const sendLine = args.sendDate ? ` The issue goes out on ${args.sendDate}.` : "";
  const label = args.specialLabel?.trim() || "the sponsored section";
  const sponsorSupplied = !!args.sponsoredCopy?.trim();
  const sponsorKey = args.template?.sections.find((sec) => sec.kind === "sponsor")?.key;
  const parts: string[] = [];
  if (args.video) {
    const v = args.video;
    parts.push(
      `Draft the "${args.formatName}" issue for this video. Today is ${today}.${sendLine}`,
      ...(v.voiceName
        ? [
            `VOICE: this video is from ${v.channelHandle ? `@${v.channelHandle}` : "the channel"}, so write the whole issue in ${v.voiceName}'s voice (the Skill's "${v.voiceName}'s voice" reference) and sign the intro '- ${v.voiceName}'. Ignore the other voice in the Skill.`,
          ]
        : []),
      [
        `VIDEO: "${v.title ?? "Untitled"}"`,
        `URL (use for the 'Watch The Full Video' link, the only YouTube link): ${v.url ?? "(none)"}`,
        v.thumbnailUrl ? `THUMBNAIL URL (for sections marked THUMBNAIL): ${v.thumbnailUrl}` : null,
        v.publishedAt ? `Published: ${v.publishedAt.slice(0, 10)}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      `TRANSCRIPT${v.truncated ? " (truncated — very long video)" : ""}${v.timestamped ? " (each line starts with its [M:SS] timestamp in the video)" : ""}:\n${v.transcript}`,
    );
    if (args.recentEditions?.length) {
      parts.push(
        `RECENT EDITIONS of this newsletter (newest first). Teach a different task / use case than these; the same tool from a fresh angle is fine:\n${args.recentEditions
          .map((e) => `- ${e.date ?? "?"}: ${e.subject}`)
          .join("\n")}`,
      );
    }
  } else {
    parts.push(
      `Draft the next "${args.formatName}" issue. Today is ${today}.${sendLine} The draft's default window is ${args.window.start.toISOString().slice(0, 10)} to ${today}.${brandHasCaseStudies(args.brand) ? ` Case studies are listed at ${CASE_STUDY_SITE}.` : ""}`,
    );
  }
  if (args.pillar) parts.push(describePillar(args.pillar));
  if (args.template) parts.push(describeTemplate(args.template, sponsorSupplied, args.sectionExamples));
  if (!args.video && args.usage) parts.push(STORY_RULES);
  if (!args.video && args.storyPlan) parts.push(describeStoryPlan(args.storyPlan));
  if (sponsorSupplied) {
    const where =
      args.template && sponsorKey
        ? `Leave section "${sponsorKey}" empty — the sponsor copy is inserted there.`
        : `Write that section's heading where the Skill puts it, then on its own line exactly ${SPECIAL_MARKER} — the sponsor copy is inserted there.`;
    parts.push(
      `This issue's sponsored section ("${label}") is supplied by the promo calendar — do NOT write its content and do not pick a lead magnet for it. ${where}${args.sponsoredLandingUrl ? ` Any other mention of the offer the Skill asks for (e.g. an intro teaser line) links to exactly ${args.sponsoredLandingUrl}.` : ""} For context only (don't repeat or paraphrase it elsewhere):\n${args.sponsoredCopy!.trim()}`,
    );
  } else if (args.sponsoredPlaceholder) {
    parts.push(
      `No sponsor is booked for this send date. Still write the "${label}" section in full and on-layout (headline, a 2 to 3 sentence body, 3 Key Takeaways bullets, and a CTA link to "#"), but make every piece an obvious italic placeholder, e.g. *[PLACEHOLDER: offer headline]*. Any intro teaser for the offer is a placeholder too. Never invent an offer, product or link.`,
    );
  }
  if (args.notes?.trim()) {
    parts.push(`Editor notes for this issue (follow them; they override the Skill where they conflict):\n${args.notes.trim()}`);
  }
  return parts.join("\n\n");
}

/**
 * Check a submission against the format's shape. Returns an error message
 * for the model, or null when it's acceptable. Exported for tests.
 */
export function submissionProblem(
  sub: NewsletterSubmission,
  template: NewsletterTemplate | null | undefined,
  sponsorSupplied: boolean,
  blocked?: Set<string>,
  /** The issue's pinned pillar: may appear in several sections and is never blocked. */
  pillarKey?: string | null,
): string | null {
  if (!template) {
    if (!sub.body_markdown || sub.body_markdown.trim().length < 200) return "body_markdown is missing or too short.";
    if (sponsorSupplied && !sub.body_markdown.includes(SPECIAL_MARKER)) {
      return `body_markdown must contain ${SPECIAL_MARKER} on its own line where the sponsored section goes.`;
    }
    return null;
  }
  const got = new Map((sub.sections ?? []).map((sec) => [sec.key, sec.markdown]));
  const expected = template.sections.map((sec) => sec.key);
  const unknown = [...got.keys()].filter((k) => !expected.includes(k));
  if (unknown.length) return `Unknown section keys: ${unknown.join(", ")}. Use exactly: ${expected.join(", ")}.`;
  const missing = template.sections.filter((sec) => {
    if (sec.kind === "sponsor" && sponsorSupplied) return false;
    if (sec.optional) return false;
    return !got.get(sec.key)?.trim();
  });
  if (missing.length) return `These sections are missing or empty: ${missing.map((sec) => sec.key).join(", ")}.`;
  const seen = new Map<string, string>();
  for (const sec of sub.sections ?? []) {
    const k = storyKeyOf(sec.source);
    if (!k || k === pillarKey) continue;
    if (blocked?.has(k)) return `Section "${sec.key}" uses a story this newsletter ran in the last ${RECENT_BLOCK_DAYS} days (${k}). Pick a different one.`;
    if (seen.has(k)) return `Sections "${seen.get(k)}" and "${sec.key}" use the same story (${k}). Use a different story for one of them.`;
    seen.set(k, sec.key);
  }
  return null;
}

interface LoopSpec<T> {
  args: NewsletterAgentArgs;
  firstUserTurn: string;
  tools: Anthropic.Beta.BetaToolUnion[];
  submitTool: string;
  /** Parse + check a submit call. Return the value, or an error for the model. */
  accept: (input: unknown) => { value: T } | { error: string };
  /** Tool-result text after the first accepted submission; null = done after one. */
  reviewPrompt: string | null;
}

async function runLoop<T>(spec: LoopSpec<T>): Promise<{ value: T; model: string; turns: number }> {
  const { args } = spec;
  const client = args.client ?? new Anthropic();
  const system = buildSystem(args);
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: spec.firstUserTurn }];
  let reviewing = false;
  let nudged = false;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (await args.shouldStop?.()) throw new NewsletterCancelledError("cancelled by the editor");
    // Non-streaming on purpose: on the worker dyno Sentry's Anthropic
    // integration (src/jobs/instrument.ts) swaps a streamed response for its
    // own async generator, which has no `.controller`, and the SDK's
    // MessageStream helper crashes reading `controller.signal` after the
    // last event. An explicit timeout also skips the SDK's "use streaming
    // for large max_tokens" guard.
    const message = await client.beta.messages.create(
      {
        model: newsletterModel(args.model),
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system,
        tools: spec.tools,
        messages,
      },
      { signal: args.signal, timeout: REQUEST_TIMEOUT_MS },
    );

    if (message.stop_reason === "refusal") {
      throw new NewsletterAgentError(`model refused (${message.stop_details?.category ?? "unknown"})`);
    }
    if (message.stop_reason === "max_tokens") throw new NewsletterAgentError("model hit max_tokens before finishing");

    messages.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    args.log?.(`newsletter agent turn ${turn}: ${toolUses.map((u) => u.name).join(", ") || message.stop_reason}`);
    // Server-side web_fetch calls show up as server_tool_use blocks.
    const called = [...toolUses.map((u) => u.name), ...message.content.filter((b) => b.type === "server_tool_use").map((b) => (b as { name: string }).name)];
    await Promise.resolve(args.onProgress?.({ turn, ...phaseFor(called, reviewing) })).catch(() => undefined);
    if (toolUses.length === 0) {
      if (nudged) throw new NewsletterAgentError(`model ended without calling ${spec.submitTool}`);
      nudged = true;
      messages.push({ role: "user", content: `Call ${spec.submitTool} with the complete result.` });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let accepted: { value: T } | null = null;
    for (const use of toolUses) {
      if (use.name === spec.submitTool) {
        const r = spec.accept(use.input);
        if ("error" in r) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `${r.error} Fix and resubmit.` });
          continue;
        }
        accepted = r;
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: !reviewing && spec.reviewPrompt ? spec.reviewPrompt : "Final version received.",
        });
        continue;
      }
      try {
        results.push({ type: "tool_result", tool_use_id: use.id, content: await runClientTool(use.name, use.input, args) });
      } catch (err) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: err instanceof z.ZodError ? `Invalid input: ${err.message}` : `Tool failed: ${(err as Error).message}`,
        });
      }
    }

    if (accepted && (reviewing || !spec.reviewPrompt)) return { value: accepted.value, model: message.model, turns: turn };
    if (accepted) reviewing = true;
    messages.push({ role: "user", content: results });
  }

  throw new NewsletterAgentError(`no final ${spec.submitTool} after ${MAX_TURNS} turns`);
}

export async function runNewsletterAgent(args: NewsletterAgentArgs): Promise<NewsletterAgentResult> {
  const templated = !!args.template;
  const sponsorSupplied = !!args.sponsoredCopy?.trim();
  const submit = submitNewsletterTool(templated);
  const r = await runLoop<NewsletterSubmission>({
    args,
    firstUserTurn: buildUserTurn(args),
    tools: args.video ? [submit] : [...sourceToolsFor(args.brand), submit],
    // (SOURCE_TOOLS includes the older-story tools; their results honor args.usage / args.blocked.)
    submitTool: "submit_newsletter",
    accept: (input) => {
      const parsed = SubmitInput.safeParse(input);
      if (!parsed.success) {
        return { error: `Invalid submission: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}.` };
      }
      const problem = submissionProblem(parsed.data, args.template, sponsorSupplied, args.video ? undefined : args.blocked, args.pillar ? `video:${args.pillar.productionItemId}` : null);
      if (problem) args.log?.(`newsletter agent submission rejected: ${problem}`);
      return problem ? { error: problem } : { value: parsed.data };
    },
    reviewPrompt: REVIEW_PROMPT,
  });
  return { submission: r.value, model: r.model, turns: r.turns };
}

export interface RegenerateSectionArgs extends NewsletterAgentArgs {
  template: NewsletterTemplate;
  sections: NewsletterSection[];
  sectionKey: string;
  instruction?: string | null;
  /** The issue as it stands (composed), so the rewrite fits around it. */
  currentIssue: string;
  /** Sources the issue already used (roundups), so the rewrite stays grounded. */
  sourcesNote?: string | null;
  /** "Find new story": swap the section to a different story, never one of these keys. */
  newStoryExclude?: Set<string> | null;
  /** The editor picked the new story (Find new story → search): rewrite the section around exactly this one. */
  pinnedStory?: PinnedStory | null;
}

export interface PinnedStory {
  kind: "video" | "case_study";
  key: string;
  title: string | null;
  url: string | null;
  productionItemId: string | null;
}

/** The turn's instruction for a story the editor picked. Pure; exported for tests. */
export function pinnedStoryInstruction(p: PinnedStory, steer?: string | null): string {
  const how = p.kind === "video" ? `read its transcript with get_video_transcript (production_item_id ${p.productionItemId})` : `read the case study with web_fetch (${p.url})`;
  return `NEW STORY — THE EDITOR PICKED IT: rewrite this section around exactly this ${p.kind === "video" ? "video" : "case study"}: "${p.title ?? "Untitled"}"${p.url ? ` (${p.url})` : ""}. First ${how}; every fact must come from it. Set source to it (kind ${p.kind}${p.kind === "video" ? `, production_item_id ${p.productionItemId}` : `, url ${p.url}`}).${steer?.trim() ? ` The editor's steer: ${steer.trim()}` : ""}`;
}

/** Rewrite one section of an existing issue (or, with newStoryExclude, swap it to a new story). */
export async function regenerateSection(
  args: RegenerateSectionArgs,
): Promise<{ markdown: string; source: SourceInputT | null; model: string }> {
  const sec = args.template.sections.find((x) => x.key === args.sectionKey);
  if (!sec) throw new NewsletterAgentError(`unknown section ${args.sectionKey}`);
  const current = args.sections.find((x) => x.key === sec.key)?.markdown ?? "";
  const base = buildUserTurn({ ...args, template: null, sponsoredCopy: null, sponsoredPlaceholder: false, storyPlan: null });
  const where = args.newStoryExclude && args.storyPlan ? newStoryGuidance(args.storyPlan, sec.key, args.newStoryExclude) : null;
  const examples = describeSectionExamples(args.sectionExamples?.[sec.key], 3);
  const turn = [
    base,
    `THE ISSUE AS IT STANDS:\n${args.currentIssue}`,
    args.sourcesNote ? `SOURCES THIS ISSUE USES:\n${args.sourcesNote}` : null,
    `Rewrite ONLY the section "${sec.key}"${sec.heading ? ` (heading "${sec.heading}", added for you)` : ""}. What it should contain: ${sec.hint}`,
    examples ? `HOW THIS SECTION HAS READ IN PAST ISSUES (match the voice and shape, vary the rhythm, never the content):\n${examples}` : null,
    sec.kind !== "sponsor" && sec.screenshots ? `${SCREENSHOT_RULE}\nThis section is marked SCREENSHOTS.` : null,
    sec.kind !== "sponsor" && sec.thumbnail ? `${THUMBNAIL_RULE}\nThis section is marked THUMBNAIL: keep its thumbnail image.` : null,
    `Its current content:\n${current || "(empty)"}`,
    args.pinnedStory
      ? pinnedStoryInstruction(args.pinnedStory, args.instruction)
      : args.newStoryExclude
      ? `FIND A NEW STORY: replace this section's video/case study with a DIFFERENT one and rewrite the section around it. ${where ?? "Use the tools to find it: this window's stories first, then list_older_videos / search_case_studies."} Never use a story marked blocked, and never any of these: ${[...args.newStoryExclude].join(", ") || "(none)"}. Set source to the story you chose.${args.instruction?.trim() ? ` The editor's steer: ${args.instruction.trim()}` : ""}`
      : args.instruction?.trim()
        ? `The editor's instruction (follow it): ${args.instruction.trim()}`
        : "Make it better: tighter, more specific, more on-voice, without changing what it's about. Keep the same story.",
    "Keep it consistent with the rest of the issue (don't repeat other sections), follow the Skill's house rules, never invent facts or links, then call submit_section.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await runLoop<{ markdown: string; source: SourceInputT | null }>({
    args,
    firstUserTurn: [args.video ? null : STORY_RULES, turn].filter(Boolean).join("\n\n"),
    tools: args.video ? [SUBMIT_SECTION_TOOL] : [...sourceToolsFor(args.brand), SUBMIT_SECTION_TOOL],
    submitTool: "submit_section",
    accept: (input) => {
      const parsed = SubmitSectionInput.safeParse(input);
      if (!parsed.success) return { error: "markdown is required." };
      const k = storyKeyOf(parsed.data.source);
      if (args.pinnedStory) {
        if (k !== args.pinnedStory.key) return { error: `Use the story the editor picked (${args.pinnedStory.key}) and set source to it.` };
        return { value: { markdown: parsed.data.markdown, source: parsed.data.source ?? null } };
      }
      if (args.newStoryExclude) {
        if (!k) return { error: "Set source to the new story you chose." };
        if (args.newStoryExclude.has(k)) return { error: `That story (${k}) is excluded — pick a different one.` };
      }
      if (k && k !== (args.pillar ? `video:${args.pillar.productionItemId}` : null) && args.blocked?.has(k)) return { error: `That story (${k}) ran in this newsletter in the last ${RECENT_BLOCK_DAYS} days. Pick a different one.` };
      return { value: { markdown: parsed.data.markdown, source: parsed.data.source ?? null } };
    },
    reviewPrompt: null,
  });
  return { markdown: r.value.markdown, source: r.value.source, model: r.model };
}
