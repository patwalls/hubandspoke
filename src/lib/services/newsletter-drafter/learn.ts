// The template learner: read a newsletter format's past issues (the ones
// actually sent — HubSpot / beehiiv imports and the Klaviyo era) and propose
// the template that fits them: the recurring sections in order, which are
// optional, what each one actually does (instructions written from the
// issues, not from a wish list), where each looks for its story, and STYLE
// NOTES — how the newsletter reads: voice, rhythm, how issues open and
// close, subject-line habits, what varies issue to issue. The proposal is
// stored on `newsletter_template_proposals` for the format page to review;
// saving it replaces the format's template (newsletter-template.ts), and the
// drafter then gets the style notes in its system prompt and the sections'
// past renderings as examples (exemplars.ts). Runs on the worker
// (`newsletter-template-learn`): one Opus call over up to 12 issues.

import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { brands, formats, newsletterTemplateProposals } from "@/lib/db/schema";
import { newsletterTemplateSchema, STORY_KINDS, templateFor, type NewsletterTemplate, type NewsletterTemplateSection } from "@/lib/newsletter-template";
import { newsletterModel } from "./agent";
import { brandHasCaseStudies } from "./format-config";
import { getPastIssues, type PastIssue } from "./sources";

/** How many issues the learner reads, and how much of each. */
export const LEARN_ISSUES = 12;
export const LEARN_ISSUE_CHARS = 12_000;
const REQUEST_TIMEOUT_MS = 8 * 60 * 1000;

const ProposedSection = z.object({
  key: z.string().min(1).max(40),
  heading: z.string().max(120).nullable(),
  hint: z.string().min(1).max(2000),
  story: z.enum(STORY_KINDS).nullable().optional(),
  kind: z.enum(["text", "sponsor"]).optional(),
  optional: z.boolean().optional(),
  link_buttons: z.boolean().optional(),
});
const Proposal = z.object({
  style_notes: z.string().min(50).max(6000),
  sections: z.array(ProposedSection).min(1).max(20),
  rationale: z.string().max(4000),
});
export type LearnedProposal = z.infer<typeof Proposal>;

const PROPOSE_TOOL: Anthropic.Beta.BetaToolUnion = {
  name: "propose_template",
  description: "Propose the newsletter template that fits the past issues: sections in order, each one's instructions, and the style notes.",
  input_schema: {
    type: "object",
    properties: {
      style_notes: {
        type: "string",
        description:
          "250-600 words on how this newsletter reads, written for a writer who has never seen it: voice and register, sentence rhythm, how issues open and close, how stories are introduced and linked, typical lengths, formatting habits (bold, lists, emoji), subject-line and preview-text patterns with 3-4 real examples, and what varies from issue to issue (so a new issue isn't a copy). Concrete, not generic.",
      },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "Stable key, lowercase with underscores. Reuse the current template's key for a section that is the same thing." },
            heading: { type: ["string", "null"], description: "The fixed heading as the issues write it (emoji included), or null when the section writes its own." },
            hint: { type: "string", description: "What goes in this section, from what the issues actually do: what it opens with, what it covers, typical length, how it links, how it ends. 1-4 sentences. Not the voice (that's in style_notes)." },
            story: { type: ["string", "null"], enum: [...STORY_KINDS, null], description: "Where the drafter looks for this section's story: newest_video, recent_video, case_study, any, or none for sections that don't cover a story." },
            kind: { type: "string", enum: ["text", "sponsor"], description: "sponsor = the sponsored / promo slot (at most one)." },
            optional: { type: "boolean", description: "True when the section is missing from some issues." },
            link_buttons: { type: "boolean", description: "True when the section's call-to-action is a standalone link line that reads like a button." },
          },
          required: ["key", "heading", "hint"],
        },
      },
      rationale: { type: "string", description: "For the reviewer: what you kept, changed or added versus the current template, and why, in a few short lines." },
    },
    required: ["style_notes", "sections", "rationale"],
  },
};

/** Normalize a section key the model wrote. */
const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "section";

/**
 * The model's proposal applied onto the current template: sections take the
 * current section's look and settings when they are the same section (same
 * key, or the same heading), new ones get defaults; style/hubspot/beehiiv/lock
 * stay as they are. Validated. Pure; exported for tests.
 */
export function applyProposal(current: NewsletterTemplate, p: LearnedProposal, learnedFrom: number, now: Date = new Date()): NewsletterTemplate {
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const match = (sec: { key: string; heading: string | null }) =>
    current.sections.find((c) => c.key === keyOf(sec.key)) ?? (sec.heading ? current.sections.find((c) => c.heading && norm(c.heading) === norm(sec.heading)) : undefined);
  const taken = new Set<string>();
  let sponsorSeen = false;
  const sections: NewsletterTemplateSection[] = p.sections.map((sec) => {
    const base = match(sec);
    let key = base?.key ?? keyOf(sec.key);
    for (let n = 2; taken.has(key); n++) key = `${keyOf(sec.key)}_${n}`;
    taken.add(key);
    let kind: "text" | "sponsor" = sec.kind ?? base?.kind ?? "text";
    if (kind === "sponsor") {
      if (sponsorSeen) kind = "text";
      sponsorSeen = true;
    }
    return {
      key,
      heading: sec.heading?.trim() || null,
      headingLevel: base?.headingLevel ?? 2,
      kind,
      hint: sec.hint.trim(),
      ...(sec.story && sec.story !== "none" ? { story: sec.story } : base?.story && !sec.story ? { story: base.story } : {}),
      pillColor: base?.pillColor ?? null,
      boxColor: base?.boxColor ?? null,
      screenshots: base?.screenshots ?? false,
      look: base?.look ?? "text",
      thumbnail: base?.thumbnail ?? false,
      bullets: base?.bullets ?? "list",
      linkButtons: sec.link_buttons ?? base?.linkButtons ?? false,
      optional: !!sec.optional,
    };
  });
  // The current sponsor slot stays when the proposal forgot it (the promo calendar fills it).
  const curSponsor = current.sections.find((s) => s.kind === "sponsor");
  if (curSponsor && !sponsorSeen) {
    const at = Math.min(current.sections.indexOf(curSponsor), sections.length);
    sections.splice(at, 0, { ...curSponsor, hint: curSponsor.hint });
  }
  return newsletterTemplateSchema.parse({
    ...current,
    sections,
    styleNotes: p.style_notes.trim(),
    learnedAt: now.toISOString(),
    learnedFrom,
  });
}

/** The learner's prompt. Pure; exported for tests. */
export function buildLearnPrompt(args: { formatName: string; brandLabel: string; skill: string | null; current: NewsletterTemplate; issues: PastIssue[]; caseStudies: boolean }): string {
  const cur = args.current.sections.map((s, i) => `${i + 1}. key "${s.key}" — ${s.heading ? `heading "${s.heading}"` : "no fixed heading"}${s.kind === "sponsor" ? " — sponsor slot" : ""}${s.story && s.story !== "none" ? ` — story: ${s.story}` : ""}\n   ${s.hint}`).join("\n");
  const issues = args.issues
    .map((p, i) => `### Issue ${i + 1}${p.publishedAt ? ` (${p.publishedAt.slice(0, 10)})` : ""}\nSubject: ${p.subject ?? ""}\nPreview: ${p.previewText ?? ""}\n\n${p.body}`)
    .join("\n\n---\n\n");
  return [
    `You are building the issue template for the ${args.brandLabel} newsletter "${args.formatName}" from its past issues. The template drives an AI drafter: each section's instructions say what goes there, the past renderings of each section are shown to it as examples, and the style notes go into its system prompt. Your job: make the template describe what these issues ACTUALLY do, so a new issue reads like one of them.`,
    "Rules:",
    "- Sections = the recurring parts of an issue, in the order they appear, named exactly as the issues name them (emoji included). A part that only some issues have is optional. A section with no fixed name (an intro, a sign-off) has heading null.",
    "- Reuse the current template's key for a section that is the same thing, even if you rename its heading. Keep the sponsor slot as kind \"sponsor\" (at most one).",
    "- Each section's hint comes from the issues: what it opens with, what it covers, how long it usually is, how it links, how it ends. Specific and observed, 1-4 sentences. Don't restate the voice there.",
    `- story: where the drafter looks for the section's story. newest_video = the week's newest video; recent_video = another recent video; case_study = ${args.caseStudies ? "a case study from starterstory.com (this brand has them)" : "not available for this brand — don't use it"}; any = either; none for intros, sign-offs, sponsor slots.`,
    "- style_notes: how the newsletter READS, for a writer who has never seen it. Quote short real phrases where they show the voice. List 3-4 real subject lines and what they have in common. Say what varies from issue to issue so a new one isn't a copy.",
    "- rationale: for the human reviewer — what you kept, changed, added or dropped vs the current template, in a few lines.",
    `CURRENT TEMPLATE (what the drafter follows today):\n${cur}`,
    args.skill?.trim() ? `FORMAT SKILL (house rules the team wrote; the issues are the ground truth where they disagree):\n${args.skill.trim()}` : null,
    `PAST ISSUES (${args.issues.length}, newest first):\n${issues}`,
    "Call propose_template with the result.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function learnTemplate(proposalId: string, opts: { signal?: AbortSignal; log?: (msg: string) => void; client?: Anthropic } = {}): Promise<{ ok: boolean; reason?: string }> {
  const [row] = await db
    .select({ id: newsletterTemplateProposals.id, status: newsletterTemplateProposals.status, formatId: newsletterTemplateProposals.formatId })
    .from(newsletterTemplateProposals)
    .where(eq(newsletterTemplateProposals.id, proposalId))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending") return { ok: false, reason: `status_${row.status}` };
  const fail = async (message: string) => {
    await db.update(newsletterTemplateProposals).set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date() }).where(eq(newsletterTemplateProposals.id, row.id));
    return { ok: false, reason: message };
  };
  try {
    const [f] = await db
      .select({ name: formats.name, brand: formats.brand, instructions: formats.instructions, saved: formats.newsletterTemplate })
      .from(formats)
      .where(eq(formats.id, row.formatId))
      .limit(1);
    if (!f?.brand) return fail("format not found");
    const current = templateFor(f.name, f.saved);
    if (!current) return fail("this format has no newsletter template to start from");
    const [brand] = await db.select({ label: brands.label }).from(brands).where(eq(brands.slug, f.brand)).limit(1);
    // Every sent issue, whatever layout it used — the learner is here to find the layout.
    const issues = await getPastIssues(f.brand, f.name, null, [], { limit: LEARN_ISSUES, charBudget: LEARN_ISSUE_CHARS });
    if (issues.length < 2) return fail(`Only ${issues.length} past issue${issues.length === 1 ? "" : "s"} of "${f.name}" to learn from — the history sync brings in sent issues; try again after it runs.`);
    await db.update(newsletterTemplateProposals).set({ issueCount: issues.length, updatedAt: new Date() }).where(eq(newsletterTemplateProposals.id, row.id));
    const client = opts.client ?? new Anthropic();
    const prompt = buildLearnPrompt({ formatName: f.name, brandLabel: brand?.label ?? f.brand, skill: f.instructions, current, issues, caseStudies: brandHasCaseStudies(f.brand) });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
    let proposal: LearnedProposal | null = null;
    for (let attempt = 0; attempt < 2 && !proposal; attempt++) {
      const message = await client.beta.messages.create(
        {
          model: newsletterModel(),
          max_tokens: 16_000,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          tools: [PROPOSE_TOOL],
          tool_choice: { type: "tool", name: "propose_template" },
          messages,
        },
        { signal: opts.signal, timeout: REQUEST_TIMEOUT_MS },
      );
      const use = message.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const parsed = use ? Proposal.safeParse(use.input) : null;
      if (parsed?.success) {
        try {
          applyProposal(current, parsed.data, issues.length);
          proposal = parsed.data;
          break;
        } catch (err) {
          opts.log?.(`newsletter-template-learn: proposal didn't validate (${(err as Error).message})`);
        }
      }
      const why = parsed && !parsed.success ? parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "the template didn't validate (duplicate keys, more than one sponsor, or a bad field)";
      messages.push({ role: "assistant", content: message.content });
      messages.push({ role: "user", content: use ? [{ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Invalid: ${why}. Call propose_template again with a corrected proposal.` }] : "Call propose_template with the proposal." });
    }
    if (!proposal) return fail("the model didn't produce a valid template in two tries");
    const template = applyProposal(current, proposal, issues.length);
    await db
      .update(newsletterTemplateProposals)
      .set({ status: "done", proposal: template, rationale: proposal.rationale.trim(), issueCount: issues.length, error: null, updatedAt: new Date() })
      .where(eq(newsletterTemplateProposals.id, row.id));
    return { ok: true };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return fail((err as Error).message);
  }
}
