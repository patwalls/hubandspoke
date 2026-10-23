// The editor's "AI review" of a ready draft: one Opus read of the whole issue
// against the format Skill, the style notes, the past issues and the sources
// it cites, returning concrete findings — each tied to a section, with the
// rewrite instruction that fixes it, so the editor applies them one by one
// (Regenerate with that instruction) or dismisses them. Stored on
// `newsletter_drafts.review` (status running → done | failed). Runs on the
// worker (`newsletter-review`). The drafter's own review pass (agent.ts)
// stays internal; this one is the editor's second opinion, on demand.

import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { brands, formats, newsletterDrafts, type NewsletterReview, type NewsletterReviewFinding } from "@/lib/db/schema";
import { composeIssue, templateFor } from "@/lib/newsletter-template";
import { newsletterModel } from "./agent";
import { getPastIssues } from "./sources";

const REQUEST_TIMEOUT_MS = 8 * 60 * 1000;
const PAST_ISSUES_FOR_REVIEW = 3;

const Finding = z.object({
  section_key: z.string().nullable(),
  severity: z.enum(["fix", "consider"]),
  note: z.string().min(1).max(600),
  instruction: z.string().max(1200).nullable(),
});
const ReviewInput = z.object({ summary: z.string().max(800), findings: z.array(Finding).max(10) });

const REVIEW_TOOL: Anthropic.Beta.BetaToolUnion = {
  name: "submit_review",
  description: "Submit the review: a one-paragraph summary and the findings, most important first.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "2-4 sentences: what works, what the issue needs before it sends." },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            section_key: { type: ["string", "null"], description: "The template section the finding is about; null for the subject line / preview text / the issue as a whole." },
            severity: { type: "string", enum: ["fix", "consider"], description: "fix = wrong or off-voice enough to change before sending; consider = a judgment call." },
            note: { type: "string", description: "What's off, in one or two plain sentences an editor can act on." },
            instruction: { type: ["string", "null"], description: "The rewrite instruction for that section that fixes it (what to change, not how to feel), or null when it's not a rewrite (e.g. pick another subject line)." },
          },
          required: ["section_key", "severity", "note", "instruction"],
        },
      },
    },
    required: ["summary", "findings"],
  },
};

/** The review prompt. Pure; exported for tests. */
export function buildReviewPrompt(args: {
  formatName: string;
  brandLabel: string;
  skill: string | null;
  styleNotes: string | null;
  sectionKeys: { key: string; heading: string | null }[];
  subject: string;
  subjectOptions: string[];
  previewText: string;
  issue: string;
  pastIssues: { subject: string | null; body: string }[];
  notes: string | null;
}): string {
  return [
    `You are the senior editor of the ${args.brandLabel} newsletter "${args.formatName}". Review this draft issue before it sends. Be specific and useful: a finding an editor can act on in one click beats a general remark. Don't praise; don't rewrite the issue yourself — say what to change. At most 8 findings, the important ones first; an issue that's genuinely ready gets a short summary and few or no findings.`,
    "Check: voice and rhythm against the style notes / Skill / past issues; structure and length per section; every claim, number and quote grounded (flag anything that reads invented or vague); links present where the format expects them; the subject line and preview text (specific, curiosity, not clickbait, matches the lead story); repetition across sections; the sponsored section untouched if it's supplied copy; anything the editor's notes asked for that's missing.",
    `SECTIONS (use these keys in section_key): ${args.sectionKeys.map((s) => `${s.key}${s.heading ? ` ("${s.heading}")` : ""}`).join(", ")}`,
    args.styleNotes?.trim() ? `HOW THIS NEWSLETTER READS:\n${args.styleNotes.trim()}` : null,
    args.skill?.trim() ? `FORMAT SKILL:\n${args.skill.trim()}` : null,
    args.pastIssues.length
      ? `PAST ISSUES (voice reference):\n${args.pastIssues.map((p, i) => `### Past issue ${i + 1}\nSubject: ${p.subject ?? ""}\n\n${p.body}`).join("\n\n---\n\n")}`
      : null,
    args.notes?.trim() ? `EDITOR NOTES FOR THIS ISSUE:\n${args.notes.trim()}` : null,
    `THE DRAFT\nSubject: ${args.subject}\nOther subject options: ${args.subjectOptions.filter((s) => s !== args.subject).join(" | ") || "(none)"}\nPreview text: ${args.previewText}\n\n${args.issue}`,
    "Call submit_review.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function reviewDraft(draftId: string, opts: { signal?: AbortSignal; log?: (msg: string) => void; client?: Anthropic } = {}): Promise<{ ok: boolean; reason?: string }> {
  const [row] = await db
    .select({
      id: newsletterDrafts.id,
      brand: newsletterDrafts.brand,
      status: newsletterDrafts.status,
      revision: newsletterDrafts.revision,
      subject: newsletterDrafts.subject,
      subjectOptions: newsletterDrafts.subjectOptions,
      previewText: newsletterDrafts.previewText,
      sections: newsletterDrafts.sections,
      notes: newsletterDrafts.notes,
      specialCopy: newsletterDrafts.specialCopy,
      specialSource: newsletterDrafts.specialSource,
      review: newsletterDrafts.review,
      formatName: formats.name,
      formatInstructions: formats.instructions,
      formatTemplate: formats.newsletterTemplate,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, draftId))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.review?.status !== "running") return { ok: false, reason: "not_requested" };
  const write = (review: NewsletterReview) => db.update(newsletterDrafts).set({ review, updatedAt: new Date() }).where(eq(newsletterDrafts.id, row.id));
  const fail = async (message: string) => {
    await write({ status: "failed", revision: row.revision, summary: null, findings: [], error: message.slice(0, 1000), at: new Date().toISOString() });
    return { ok: false, reason: message };
  };
  try {
    const template = templateFor(row.formatName, row.formatTemplate);
    if (!template || row.status !== "ready") return fail("the draft isn't ready");
    const [brand] = await db.select({ label: brands.label }).from(brands).where(eq(brands.slug, row.brand)).limit(1);
    const pastIssues = await getPastIssues(row.brand, row.formatName, null, template.sections.map((s) => s.heading ?? "").filter(Boolean), { limit: PAST_ISSUES_FOR_REVIEW, charBudget: 6_000 }).catch(() => []);
    const sponsor = row.specialCopy ? { copy: row.specialCopy, landingUrl: row.specialSource?.landingUrl ?? null } : null;
    const prompt = buildReviewPrompt({
      formatName: row.formatName,
      brandLabel: brand?.label ?? row.brand,
      skill: row.formatInstructions,
      styleNotes: template.styleNotes,
      sectionKeys: template.sections.map((s) => ({ key: s.key, heading: s.heading })),
      subject: row.subject ?? "",
      subjectOptions: row.subjectOptions,
      previewText: row.previewText ?? "",
      issue: composeIssue(template, row.sections, sponsor),
      pastIssues,
      notes: row.notes,
    });
    const client = opts.client ?? new Anthropic();
    const message = await client.beta.messages.create(
      {
        model: newsletterModel(),
        max_tokens: 8_000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools: [REVIEW_TOOL],
        tool_choice: { type: "tool", name: "submit_review" },
        messages: [{ role: "user", content: prompt }],
      },
      { signal: opts.signal, timeout: REQUEST_TIMEOUT_MS },
    );
    const use = message.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const parsed = use ? ReviewInput.safeParse(use.input) : null;
    if (!parsed?.success) return fail("the model didn't return a review");
    const keys = new Set(template.sections.map((s) => s.key));
    const findings: NewsletterReviewFinding[] = parsed.data.findings.map((f, i) => ({
      id: `${row.revision}-${i + 1}`,
      sectionKey: f.section_key && keys.has(f.section_key) ? f.section_key : null,
      severity: f.severity,
      note: f.note.trim(),
      instruction: f.instruction?.trim() || null,
    }));
    await write({ status: "done", revision: row.revision, summary: parsed.data.summary.trim(), findings, at: new Date().toISOString() });
    opts.log?.(`newsletter-review: ${row.id} → ${findings.length} findings`);
    return { ok: true };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return fail((err as Error).message);
  }
}
