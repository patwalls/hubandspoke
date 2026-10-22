// "Rewrite in our voice" for a newsletter draft's sponsored section (The
// Special). One Haiku call: the sponsor's copy in, the same offer in the
// newsletter's voice out, anchored on past issues of the format. Runs inside
// the request (a few seconds), not on the worker. Fail-soft: callers get
// `{ ok: false }` and keep the current copy.

import Anthropic from "@anthropic-ai/sdk";
import type { PastIssue } from "./sources";
import { newsletterModel } from "./agent";

const MAX_EXEMPLARS = 3;

export type SpecialRewriteResult = { ok: true; copy: string } | { ok: false; failure: string };

export async function rewriteSpecial(args: {
  formatName: string;
  /** What the section is called ("The Special", "Free Resource"). */
  label: string;
  formatInstructions: string | null;
  sponsorCopy: string;
  landingUrl: string | null;
  pastIssues: PastIssue[];
  client?: Anthropic;
}): Promise<SpecialRewriteResult> {
  const client = args.client ?? new Anthropic();
  const examples = args.pastIssues
    .slice(0, MAX_EXEMPLARS)
    .map((p, i) => `### Past issue ${i + 1}\n${p.body}`)
    .join("\n\n---\n\n");

  const system = [
    `You rewrite the sponsored section ("${args.label}") of the "${args.formatName}" newsletter so it reads in the newsletter's own voice.`,
    "Keep the offer, the product name, every factual claim and every number exactly as the sponsor gave them. Never add a claim, statistic, price, deadline or benefit the sponsor copy doesn't contain. If the sponsor copy is only a short brief or theme, write a short section that pitches it without inventing specifics.",
    args.landingUrl
      ? `End with one call-to-action line that links to exactly this URL: ${args.landingUrl}`
      : "Keep any call-to-action link from the sponsor copy unchanged.",
    "Match the voice, line length and formatting of the sponsored sections in the past issues below. Output only the section's content in Markdown (no course heading, no preamble).",
    args.formatInstructions?.trim() ? `\n## FORMAT SKILL\n${args.formatInstructions.trim()}` : "",
    examples ? `\n## PAST ISSUES\n${examples}` : "",
  ].join("\n");

  try {
    const res = await client.messages.create({
      // Same model as the drafts (Opus 5.5 by default), so the sponsor copy reads like the rest of the issue.
      model: newsletterModel(),
      max_tokens: 4000,
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: `Sponsor copy:\n\n${args.sponsorCopy.trim()}` }],
    });
    if (res.stop_reason === "refusal") return { ok: false, failure: "model refused" };
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) return { ok: false, failure: "empty rewrite" };
    return { ok: true, copy: text };
  } catch (err) {
    return { ok: false, failure: (err as Error).message };
  }
}
