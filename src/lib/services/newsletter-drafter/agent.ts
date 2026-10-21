// The newsletter drafter's agent loop. One Opus run per draft: the model
// gathers its own material through tools (the window's published videos and
// their transcripts, recent starterstory.com case studies via the content API
// + web_fetch, the lead-magnet catalog for CTAs), writes the issue in the
// format Skill's voice, and submits it through `submit_newsletter`. A second
// pass then reviews that submission against the Skill and past issues and
// submits the revised version — the "Claude reviews its own draft" step of
// the original Claude-skill workflow, folded into the same conversation so
// the cached prompt is reused.
//
// Manual loop (not the SDK tool runner) because the run has two phases keyed
// off a client tool, needs `pause_turn` resumption for web_fetch, and must
// stop on refusal / max_tokens instead of looping.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
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
const SubmitInput = z.object({
  subject_options: z.array(z.string().min(1).max(120)).min(3).max(6),
  subject: z.string().min(1).max(120),
  preview_text: z.string().max(200),
  body_markdown: z.string().min(200),
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

const DAYS_SCHEMA = {
  type: "object" as const,
  properties: {
    days: {
      type: ["integer", "null"],
      description: "Lookback in days ending at the draft's end date. Omit/null to use the draft's window.",
    },
  },
};

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
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
    name: "submit_newsletter",
    description:
      "Submit the finished issue. body_markdown is the full email body in Markdown (headings, links, lists). sources lists every video/case study the issue draws on.",
    input_schema: {
      type: "object",
      properties: {
        subject_options: { type: "array", items: { type: "string" }, description: "3-6 distinct subject lines, best first." },
        subject: { type: "string", description: "The chosen subject line (normally subject_options[0])." },
        preview_text: { type: "string", description: "Inbox preview text." },
        body_markdown: { type: "string" },
        sources: {
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
        },
      },
      required: ["subject_options", "subject", "preview_text", "body_markdown", "sources"],
    },
  },
  {
    type: "web_fetch_20260209",
    name: "web_fetch",
    allowed_domains: ["starterstory.com"],
    max_uses: 12,
  },
];

/** single_video formats get only the submit tool: the transcript is in the prompt and nothing else is a valid source. */
const SINGLE_VIDEO_TOOLS: Anthropic.Beta.BetaToolUnion[] = TOOLS.filter(
  (t) => "name" in t && t.name === "submit_newsletter",
);

export interface NewsletterAgentArgs {
  brand: string;
  brandLabel: string;
  brandGuidelines: string | null;
  formatName: string;
  formatInstructions: string | null;
  pastIssues: PastIssue[];
  window: DraftWindow;
  /** Editor steer for this issue (e.g. the offer to pitch). */
  notes?: string | null;
  /** YYYY-MM-DD the issue goes out. */
  sendDate?: string | null;
  /** The sponsored section's copy from the promo calendar. When set the agent
   *  leaves SPECIAL_MARKER in its place instead of writing it. */
  sponsoredCopy?: string | null;
  /** The sponsor's landing page (the How-To's intro teaser links to it too). */
  sponsoredLandingUrl?: string | null;
  /** What the sponsored section is called ("The Special", "Free Resource"). */
  specialLabel?: string | null;
  /** No promo matched and the format wants a marked placeholder instead of the agent's own pick. */
  sponsoredPlaceholder?: boolean;
  /** single_video formats: the one video this issue is written from. When set
   *  the agent gets only submit_newsletter — no search, no web. */
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
          "The video's transcript is in the first message. Every feature, button, setting, prompt pattern, price, limit and result you mention must come from that transcript. You design the scenario and the steps; you never invent capabilities. Where a detail is missing, keep it general and say so in the build note. Never invent links.",
          "Follow the format Skill below exactly: it owns structure, section order, voice, length and house rules.",
          "Write the body in Markdown.",
          "When the issue is done, call submit_newsletter.",
        ]
      : [
          `You write the ${args.brandLabel} newsletter "${args.formatName}".`,
          "You draft one complete issue that an editor will review, then send from their email tool.",
          "Gather your own material with the tools: the brand's videos published in the window (read the transcripts of the ones you use) and recent case studies on starterstory.com (read the full page with web_fetch before writing about one). Never invent facts, numbers, quotes or links — everything in the issue must come from a transcript, a fetched page, or the lead-magnet list.",
          "Follow the format Skill below exactly when it says how far back to look, what to include, structure, length and CTA rules. Where the Skill is silent, match the past issues.",
          "Write the body in Markdown. Link every video and case study you mention with its real URL.",
          "When the issue is done, call submit_newsletter.",
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

async function runClientTool(
  name: string,
  input: unknown,
  args: NewsletterAgentArgs,
): Promise<string> {
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

/** The first user turn. Exported for tests. */
export function buildUserTurn(args: NewsletterAgentArgs): string {
  const today = args.window.end.toISOString().slice(0, 10);
  const sendLine = args.sendDate ? ` The issue goes out on ${args.sendDate}.` : "";
  const label = args.specialLabel?.trim() || "the sponsored section";
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
  if (args.sponsoredCopy?.trim()) {
    parts.push(
      `This issue's sponsored section ("${label}") is supplied by the promo calendar — do NOT write its content and do not pick a lead magnet for it. Write that section's heading where the Skill puts it, then on its own line exactly ${SPECIAL_MARKER} — the sponsor copy is inserted there.${args.sponsoredLandingUrl ? ` Any other mention of the offer the Skill asks for (e.g. an intro teaser line) links to exactly ${args.sponsoredLandingUrl}.` : ""} For context only (don't repeat or paraphrase it elsewhere):\n${args.sponsoredCopy.trim()}`,
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

export async function runNewsletterAgent(args: NewsletterAgentArgs): Promise<NewsletterAgentResult> {
  const client = args.client ?? new Anthropic();
  const system = buildSystem(args);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: buildUserTurn(args),
    },
  ];

  let phase: "draft" | "review" = "draft";
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
        tools: args.video ? SINGLE_VIDEO_TOOLS : TOOLS,
        messages,
      },
      { signal: args.signal, timeout: REQUEST_TIMEOUT_MS },
    );

    if (message.stop_reason === "refusal") {
      throw new NewsletterAgentError(`model refused (${message.stop_details?.category ?? "unknown"})`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new NewsletterAgentError("model hit max_tokens before finishing");
    }

    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (nudged) throw new NewsletterAgentError("model ended without calling submit_newsletter");
      nudged = true;
      messages.push({ role: "user", content: "Call submit_newsletter with the complete issue." });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let accepted: NewsletterSubmission | null = null;
    for (const use of toolUses) {
      if (use.name === "submit_newsletter") {
        const parsed = SubmitInput.safeParse(use.input);
        if (!parsed.success) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: `Invalid submission: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Fix and resubmit.`,
          });
          continue;
        }
        if (args.sponsoredCopy?.trim() && !parsed.data.body_markdown.includes(SPECIAL_MARKER)) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: `body_markdown must contain ${SPECIAL_MARKER} on its own line where the sponsored section goes. Resubmit.`,
          });
          continue;
        }
        accepted = parsed.data;
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: phase === "draft" ? REVIEW_PROMPT : "Final version received.",
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

    if (accepted && phase === "review") {
      return { submission: accepted, model: message.model, turns: turn };
    }
    if (accepted) phase = "review";
    messages.push({ role: "user", content: results });
  }

  throw new NewsletterAgentError(`no final submission after ${MAX_TURNS} turns`);
}
