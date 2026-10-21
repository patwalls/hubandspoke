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
import { getVideoTranscript, listRecentCaseStudies, listRecentVideos, type PastIssue } from "./sources";
import { SPECIAL_MARKER } from "./special-compose";
import { toolWindow, type DraftWindow } from "./window";

export const NEWSLETTER_MODEL = "claude-opus-5-5";
const MAX_TURNS = 30;
const MAX_TOKENS = 32_000;
/** Per-turn ceiling for one non-streaming call (a long write turn + thinking). */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const CASE_STUDY_SITE = "https://www.starterstory.com/explore";

const DaysInput = z.object({ days: z.number().int().min(1).max(31).nullable().optional() });
const TranscriptInput = z.object({ production_item_id: z.string().uuid() });
const SectionInput = z.object({ key: z.string().min(1), markdown: z.string() });
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
const SubmitSectionInput = z.object({ markdown: z.string().min(1) });

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
                  properties: { key: { type: "string" }, markdown: { type: "string" } },
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
  description: "Submit the rewritten section's Markdown (content only; its fixed heading, if any, is added for you).",
  input_schema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
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
  /** Model override (format-config.ts); defaults to NEWSLETTER_MODEL. */
  model?: string;
  signal?: AbortSignal;
  client?: Anthropic;
}

export interface SourceVideo {
  productionItemId: string;
  title: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  transcript: string;
  truncated: boolean;
}

export interface NewsletterAgentResult {
  submission: NewsletterSubmission;
  model: string;
  turns: number;
}

export class NewsletterAgentError extends Error {}

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
          "Gather your own material with the tools: the brand's videos published in the window (read the transcripts of the ones you use) and recent case studies on starterstory.com (read the full page with web_fetch before writing about one). Never invent facts, numbers, quotes or links — everything in the issue must come from a transcript, a fetched page, or the lead-magnet list.",
          "Follow the format Skill below exactly when it says how far back to look, what to include, length and CTA rules. Where the Skill is silent, match the past issues.",
          "Write in Markdown. Link every video and case study you mention with its real URL.",
        ]
  ).join("\n");

  const context: string[] = [];
  if (args.brandGuidelines?.trim()) context.push(`## BRAND GUIDELINES\n${args.brandGuidelines.trim()}`);
  context.push(
    `## FORMAT SKILL — ${args.formatName}\n${args.formatInstructions?.trim() || "(No Skill written yet — follow the past issues closely.)"}`,
  );
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

async function runClientTool(name: string, input: unknown, args: NewsletterAgentArgs): Promise<string> {
  switch (name) {
    case "list_recent_videos": {
      const { days } = DaysInput.parse(input ?? {});
      const w = toolWindow(args.window, days);
      const videos = await listRecentVideos(args.brand, w);
      return JSON.stringify({ window: { start: w.start.toISOString(), end: w.end.toISOString() }, videos });
    }
    case "get_video_transcript": {
      const { production_item_id } = TranscriptInput.parse(input);
      const t = await getVideoTranscript(production_item_id);
      if (!t) return "No transcript is available for this video.";
      return t.truncated ? `${t.text}\n\n[transcript truncated]` : t.text;
    }
    case "list_recent_case_studies": {
      const { days } = DaysInput.parse(input ?? {});
      const w = toolWindow(args.window, days);
      const studies = await listRecentCaseStudies(w);
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

/** The template block of the first user turn. Exported for tests. */
export function describeTemplate(template: NewsletterTemplate, sponsorSupplied: boolean): string {
  const lines = template.sections.map((sec, i) => {
    const heading = sec.heading ? `fixed heading "${sec.heading}" (added for you; don't repeat it)` : "no fixed heading (write your own if the section needs one)";
    const sponsor =
      sec.kind === "sponsor" && sponsorSupplied ? " — SUPPLIED BY THE PROMO CALENDAR: submit an empty string for this key" : "";
    return `${i + 1}. key "${sec.key}" — ${heading}${sponsor}\n   ${sec.hint}`;
  });
  return `ISSUE TEMPLATE — submit exactly these sections, every key, in this order (sections[].key / sections[].markdown):\n${lines.join("\n")}`;
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
      [
        `VIDEO: "${v.title ?? "Untitled"}"`,
        `URL (use for the 'Watch The Full Video' link, the only YouTube link): ${v.url ?? "(none)"}`,
        v.thumbnailUrl ? `Thumbnail image (place it as a Markdown image under the first article headline): ${v.thumbnailUrl}` : null,
        v.publishedAt ? `Published: ${v.publishedAt.slice(0, 10)}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      `TRANSCRIPT${v.truncated ? " (truncated — very long video)" : ""}:\n${v.transcript}`,
    );
  } else {
    parts.push(
      `Draft the next "${args.formatName}" issue. Today is ${today}.${sendLine} The draft's default window is ${args.window.start.toISOString().slice(0, 10)} to ${today}. Case studies are listed at ${CASE_STUDY_SITE}.`,
    );
  }
  if (args.template) parts.push(describeTemplate(args.template, sponsorSupplied));
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
    return !got.get(sec.key)?.trim();
  });
  if (missing.length) return `These sections are missing or empty: ${missing.map((sec) => sec.key).join(", ")}.`;
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
    // Non-streaming on purpose: on the worker dyno Sentry's Anthropic
    // integration (src/jobs/instrument.ts) swaps a streamed response for its
    // own async generator, which has no `.controller`, and the SDK's
    // MessageStream helper crashes reading `controller.signal` after the
    // last event. An explicit timeout also skips the SDK's "use streaming
    // for large max_tokens" guard.
    const message = await client.beta.messages.create(
      {
        model: args.model ?? NEWSLETTER_MODEL,
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
    tools: args.video ? [submit] : [...SOURCE_TOOLS, submit],
    submitTool: "submit_newsletter",
    accept: (input) => {
      const parsed = SubmitInput.safeParse(input);
      if (!parsed.success) {
        return { error: `Invalid submission: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}.` };
      }
      const problem = submissionProblem(parsed.data, args.template, sponsorSupplied);
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
}

/** Rewrite one section of an existing issue. Returns the new Markdown. */
export async function regenerateSection(args: RegenerateSectionArgs): Promise<{ markdown: string; model: string }> {
  const sec = args.template.sections.find((x) => x.key === args.sectionKey);
  if (!sec) throw new NewsletterAgentError(`unknown section ${args.sectionKey}`);
  const current = args.sections.find((x) => x.key === sec.key)?.markdown ?? "";
  const base = buildUserTurn({ ...args, template: null, sponsoredCopy: null, sponsoredPlaceholder: false });
  const turn = [
    base,
    `THE ISSUE AS IT STANDS:\n${args.currentIssue}`,
    args.sourcesNote ? `SOURCES THIS ISSUE USES:\n${args.sourcesNote}` : null,
    `Rewrite ONLY the section "${sec.key}"${sec.heading ? ` (heading "${sec.heading}", added for you)` : ""}. What it should contain: ${sec.hint}`,
    `Its current content:\n${current || "(empty)"}`,
    args.instruction?.trim()
      ? `The editor's instruction (follow it): ${args.instruction.trim()}`
      : "Make it better: tighter, more specific, more on-voice, without changing what it's about.",
    "Keep it consistent with the rest of the issue (don't repeat other sections), follow the Skill's house rules, never invent facts or links, then call submit_section.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await runLoop<string>({
    args,
    firstUserTurn: turn,
    tools: args.video ? [SUBMIT_SECTION_TOOL] : [...SOURCE_TOOLS, SUBMIT_SECTION_TOOL],
    submitTool: "submit_section",
    accept: (input) => {
      const parsed = SubmitSectionInput.safeParse(input);
      return parsed.success ? { value: parsed.data.markdown } : { error: "markdown is required." };
    },
    reviewPrompt: null,
  });
  return { markdown: r.value, model: r.model };
}
