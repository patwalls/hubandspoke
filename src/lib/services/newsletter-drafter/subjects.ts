// "More subject ideas": six fresh subject line + preview text pairs for a
// ready draft, each with its angle, in the newsletter's own subject-line
// habits (its past subjects, from the issue history and sent issues). One
// Sonnet call with a single forced tool, fast enough for the request path;
// fail-soft ({ ok: false, failure }). New lines are appended to the draft's
// subject options (never replacing the chosen subject).

import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { formats, newsletterDrafts, newsletterIssueHistory, productionItems } from "@/lib/db/schema";
import { composeIssue, templateFor } from "@/lib/newsletter-template";
import { usageGroupFor } from "./usage";

const MODEL = "claude-sonnet-5-5";
const PAST_SUBJECTS = 30;
/** The issue is context, not the thing to summarize: the lead matters most. */
const ISSUE_CHAR_BUDGET = 9_000;

export interface SubjectIdea {
  subject: string;
  previewText: string;
  angle: string;
}

export type SubjectIdeasResult = { ok: true; ideas: SubjectIdea[] } | { ok: false; failure: "not_found" | "not_ready" | "llm-error" | "llm-empty"; message?: string };

const Output = z.object({
  ideas: z.array(z.object({ subject: z.string().min(1).max(120), preview_text: z.string().max(200), angle: z.string().min(1).max(60) })).min(1).max(8),
});

const TOOL: Anthropic.Tool = {
  name: "suggest_subjects",
  description: "Six subject line + preview text pairs for the issue, each from a different angle.",
  input_schema: {
    type: "object",
    properties: {
      ideas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subject: { type: "string" },
            preview_text: { type: "string", description: "The inbox preview line that follows the subject (not a repeat of it)." },
            angle: { type: "string", description: "The angle in 1-3 words: e.g. number, curiosity gap, contrarian, how-to, story, question, plain." },
          },
          required: ["subject", "preview_text", "angle"],
        },
      },
    },
    required: ["ideas"],
  },
};

/** Past subject lines of this newsletter, newest first (history + sent issues), deduped. */
export async function pastSubjects(brand: string, formatName: string, limit = PAST_SUBJECTS): Promise<string[]> {
  const group = usageGroupFor(formatName);
  const [hist, items] = await Promise.all([
    db
      .select({ s: newsletterIssueHistory.subject, d: newsletterIssueHistory.sentDate })
      .from(newsletterIssueHistory)
      .where(and(eq(newsletterIssueHistory.scheduleGroup, group), isNotNull(newsletterIssueHistory.subject)))
      .orderBy(desc(newsletterIssueHistory.sentDate))
      .limit(limit),
    db
      .select({ s: productionItems.title, d: sql<string | null>`${productionItems.publishedAt}::date::text` })
      .from(productionItems)
      .where(and(eq(productionItems.brand, brand), eq(productionItems.postType, "newsletter"), eq(productionItems.status, "Published"), sql`lower(${productionItems.format}) = lower(${formatName})`, isNotNull(productionItems.title)))
      .orderBy(desc(productionItems.publishedAt))
      .limit(limit),
  ]);
  const seen = new Set<string>();
  return [...hist, ...items]
    .filter((r) => r.s?.trim())
    .sort((a, b) => (b.d ?? "").localeCompare(a.d ?? ""))
    .map((r) => r.s!.trim())
    .filter((s) => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, limit);
}

/** The prompt. Pure; exported for tests. */
export function buildSubjectsPrompt(args: { formatName: string; subject: string; options: string[]; previewText: string; issue: string; past: string[]; notes: string | null }): string {
  return [
    `Write six subject line + preview text pairs for this issue of the newsletter "${args.formatName}", each from a different angle. Match the newsletter's own subject habits (length, casing, punctuation, use of numbers and names) — the past subject lines below show them — and never repeat one of them or one of the current options. Lead with the issue's strongest, most specific hook; no clickbait, no fake urgency, nothing the issue doesn't deliver.`,
    `PAST SUBJECT LINES (newest first):\n${args.past.map((s) => `- ${s}`).join("\n") || "(none on record)"}`,
    `CURRENT SUBJECT: ${args.subject || "(none)"}\nCURRENT OPTIONS: ${args.options.join(" | ") || "(none)"}\nCURRENT PREVIEW TEXT: ${args.previewText || "(none)"}`,
    args.notes?.trim() ? `THE ANGLE (what the editor said this issue is about — the subject line should make its point):\n${args.notes.trim()}` : null,
    `THE ISSUE:\n${args.issue.length > ISSUE_CHAR_BUDGET ? `${args.issue.slice(0, ISSUE_CHAR_BUDGET)}\n[…]` : args.issue}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function suggestSubjectLines(draftId: string, client: Anthropic = new Anthropic()): Promise<SubjectIdeasResult> {
  const [row] = await db
    .select({
      id: newsletterDrafts.id,
      brand: newsletterDrafts.brand,
      status: newsletterDrafts.status,
      subject: newsletterDrafts.subject,
      subjectOptions: newsletterDrafts.subjectOptions,
      previewText: newsletterDrafts.previewText,
      sections: newsletterDrafts.sections,
      bodyMarkdown: newsletterDrafts.bodyMarkdown,
      notes: newsletterDrafts.notes,
      specialCopy: newsletterDrafts.specialCopy,
      specialSource: newsletterDrafts.specialSource,
      formatName: formats.name,
      formatTemplate: formats.newsletterTemplate,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, draftId))
    .limit(1);
  if (!row) return { ok: false, failure: "not_found" };
  if (row.status !== "ready") return { ok: false, failure: "not_ready" };
  const template = templateFor(row.formatName, row.formatTemplate);
  const issue = template ? composeIssue(template, row.sections, row.specialCopy ? { copy: row.specialCopy, landingUrl: row.specialSource?.landingUrl ?? null } : null) : (row.bodyMarkdown ?? "");
  const past = await pastSubjects(row.brand, row.formatName).catch(() => []);
  const prompt = buildSubjectsPrompt({ formatName: row.formatName, subject: row.subject ?? "", options: row.subjectOptions, previewText: row.previewText ?? "", issue, past, notes: row.notes });
  let ideas: SubjectIdea[];
  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2_000,
      tools: [TOOL],
      messages: [{ role: "user", content: prompt }],
    });
    let use = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!use) {
      // Answered in prose: one nudge to use the tool.
      const again = await client.messages.create({
        model: MODEL,
        max_tokens: 2_000,
        tools: [TOOL],
        messages: [{ role: "user", content: prompt }, { role: "assistant", content: message.content }, { role: "user", content: "Call suggest_subjects with the result." }],
      });
      use = again.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    }
    const parsed = use ? Output.safeParse(use.input) : null;
    if (!parsed?.success) return { ok: false, failure: "llm-empty" };
    const known = new Set([...row.subjectOptions, ...past].map((s) => s.toLowerCase().trim()));
    ideas = parsed.data.ideas
      .map((i) => ({ subject: i.subject.trim(), previewText: i.preview_text.trim(), angle: i.angle.trim() }))
      .filter((i) => i.subject && !known.has(i.subject.toLowerCase()) && known.add(i.subject.toLowerCase()));
  } catch (err) {
    return { ok: false, failure: "llm-error", message: (err as Error).message };
  }
  if (!ideas.length) return { ok: false, failure: "llm-empty" };
  await db
    .update(newsletterDrafts)
    .set({ subjectOptions: [...row.subjectOptions, ...ideas.map((i) => i.subject)].slice(0, 24), revision: sql`${newsletterDrafts.revision} + 1`, updatedAt: new Date() })
    .where(eq(newsletterDrafts.id, row.id));
  return { ok: true, ideas };
}
