// The editor's whole-email Revise: the editor writes one note for the whole
// issue ("cut it by a third", "the pitch should mention the database is
// free", "less hype"); one fast Sonnet read of the issue turns it into a
// rewrite instruction for each section the note touches, and each of those
// sections then runs the normal per-section Regenerate with it (grounded,
// voiced, cancellable, `newsletter-section-regenerate`). Sections the note
// doesn't touch are left alone. The sponsored section is never touched (the
// Ad panel owns it).
//
// The route marks every revisable section `regenerating` before enqueueing
// `newsletter-revise`, so the editor shows them all working while the plan
// runs; the plan then releases the untouched ones and hands the rest to
// their section jobs. A section the editor cancels mid-plan stays cancelled.

import Anthropic from "@anthropic-ai/sdk";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { formats, newsletterDrafts } from "@/lib/db/schema";
import { templateFor, type NewsletterSection, type NewsletterTemplate } from "@/lib/newsletter-template";

const MODEL = "claude-sonnet-5-5";

export interface SectionRevision {
  sectionKey: string;
  instruction: string;
}

const Output = z.object({
  edits: z.array(z.object({ section_key: z.string(), instruction: z.string().max(1500) })).max(20),
});

const TOOL: Anthropic.Tool = {
  name: "submit_revision_plan",
  description: "For each section the editor's note asks to change, the rewrite instruction for that section.",
  input_schema: {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            section_key: { type: "string" },
            instruction: {
              type: "string",
              description:
                "What to change in THIS section to carry out the note: concrete (what to cut, add, move, reword), carrying over any facts, links or wording the editor gave. Not how to feel.",
            },
          },
          required: ["section_key", "instruction"],
        },
      },
    },
    required: ["edits"],
  },
};

/** Sections the whole-email Revise may rewrite: the template's text sections (never the sponsored one). Pure; exported for tests. */
export function revisableKeys(template: NewsletterTemplate): string[] {
  return template.sections.filter((s) => s.kind !== "sponsor").map((s) => s.key);
}

/** Keep one edit per known section with a real instruction, in template order. Pure; exported for tests. */
export function revisionEdits(raw: { section_key: string; instruction: string }[], keys: string[]): SectionRevision[] {
  const byKey = new Map<string, string>();
  for (const e of raw) {
    const instruction = e.instruction.trim();
    if (keys.includes(e.section_key) && instruction && !byKey.has(e.section_key)) byKey.set(e.section_key, instruction);
  }
  return keys.filter((k) => byKey.has(k)).map((k) => ({ sectionKey: k, instruction: byKey.get(k)! }));
}

/** The instruction a section's Regenerate gets: its part of the plan, with the editor's own note for context. Pure; exported for tests. */
export function sectionInstruction(edit: SectionRevision, note: string): string {
  return `${edit.instruction}\n\n(The editor's note for the whole issue, for context — change only what concerns this section: "${note.trim()}")`;
}

export type RevisionPlan = { ok: true; edits: SectionRevision[] } | { ok: false; failure: "llm-error" | "llm-empty"; message?: string };

export async function planRevision(
  args: { formatName: string; note: string; angle: string | null; template: NewsletterTemplate; sections: NewsletterSection[] },
  client: Anthropic = new Anthropic(),
): Promise<RevisionPlan> {
  const keys = revisableKeys(args.template);
  const names = new Map(args.template.sections.map((s) => [s.key, s.heading ?? s.key]));
  const body = keys
    .map((k) => `### section_key: ${k} (${names.get(k)})\n${args.sections.find((s) => s.key === k)?.markdown.trim() || "(empty)"}`)
    .join("\n\n");
  const prompt = [
    `You're helping the editor of the "${args.formatName}" newsletter revise a draft issue. They wrote ONE note for the whole email. Work out which sections it asks to change and, for each, the rewrite instruction a writer revising only that section would need. A note about the whole issue (tone, length, a word to avoid) applies to every section it's true of; a note about one thing touches only the section(s) where that thing is. Leave out sections the note doesn't touch. Keep facts, links and exact wording the editor gave.`,
    args.angle?.trim() ? `The issue's angle (what it's about): ${args.angle.trim()}` : null,
    `THE EDITOR'S NOTE:\n"""\n${args.note.trim()}\n"""`,
    `THE ISSUE (only these sections can change):\n\n${body}`,
    "Call submit_revision_plan.",
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const message = await client.messages.create({ model: MODEL, max_tokens: 3_000, tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name }, messages: [{ role: "user", content: prompt }] });
    const use = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const parsed = use ? Output.safeParse(use.input) : null;
    if (!parsed?.success) return { ok: false, failure: "llm-empty" };
    return { ok: true, edits: revisionEdits(parsed.data.edits, keys) };
  } catch (err) {
    return { ok: false, failure: "llm-error", message: (err as Error).message };
  }
}

/** Take keys out of `regenerating` (and optionally set the draft's error). */
async function release(id: string, keys: string[], error?: string) {
  if (!keys.length && error === undefined) return;
  await db
    .update(newsletterDrafts)
    .set({
      ...(keys.length
        ? { regenerating: sql`COALESCE((SELECT jsonb_agg(k) FROM jsonb_array_elements_text(${newsletterDrafts.regenerating}) k WHERE k NOT IN ${keys}), '[]'::jsonb)` }
        : {}),
      ...(error !== undefined ? { error } : {}),
      updatedAt: new Date(),
    })
    .where(eq(newsletterDrafts.id, id));
}

/**
 * Mark the draft's revisable sections `regenerating` for a whole-email Revise
 * (the route, before enqueueing). Returns the keys, or null when the draft
 * isn't a ready templated draft.
 */
export async function startRevision(draftId: string): Promise<string[] | null> {
  const [row] = await db
    .select({ status: newsletterDrafts.status, regenerating: newsletterDrafts.regenerating, formatName: formats.name, formatTemplate: formats.newsletterTemplate })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, draftId))
    .limit(1);
  const template = row ? templateFor(row.formatName, row.formatTemplate) : null;
  if (!row || !template || row.status !== "ready") return null;
  const keys = revisableKeys(template);
  const next = [...new Set([...row.regenerating, ...keys])];
  await db
    .update(newsletterDrafts)
    .set({ regenerating: next, error: null, updatedAt: new Date() })
    .where(and(eq(newsletterDrafts.id, draftId), eq(newsletterDrafts.status, "ready")));
  return keys;
}

/**
 * Worker: plan the revision, release the sections it doesn't touch, and hand
 * each touched one to its section Regenerate (`enqueueSection`). A failed plan
 * releases every section it held and says why on the draft.
 */
export async function reviseDraft(
  draftId: string,
  note: string,
  deps: {
    enqueueSection: (sectionKey: string, instruction: string) => Promise<void>;
    client?: Anthropic;
    log?: (msg: string) => void;
  },
): Promise<{ ok: boolean; revised?: string[]; reason?: string }> {
  const [row] = await db
    .select({
      id: newsletterDrafts.id,
      status: newsletterDrafts.status,
      notes: newsletterDrafts.notes,
      sections: newsletterDrafts.sections,
      formatName: formats.name,
      formatTemplate: formats.newsletterTemplate,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, draftId))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  const template = templateFor(row.formatName, row.formatTemplate);
  if (!template) return { ok: false, reason: "no_template" };
  const keys = revisableKeys(template);
  if (row.status !== "ready") {
    await release(row.id, keys);
    return { ok: false, reason: "not_ready" };
  }
  const plan = await planRevision({ formatName: row.formatName, note, angle: row.notes, template, sections: row.sections }, deps.client);
  if (!plan.ok) {
    await release(row.id, keys, `Revise failed: ${plan.message ?? "the model didn't return a plan"}`.slice(0, 2000));
    return { ok: false, reason: plan.failure };
  }
  // Sections the editor cancelled while the plan ran stay cancelled.
  const [cur] = await db.select({ regenerating: newsletterDrafts.regenerating }).from(newsletterDrafts).where(eq(newsletterDrafts.id, row.id)).limit(1);
  const edits = plan.edits.filter((e) => cur?.regenerating.includes(e.sectionKey));
  const touched = new Set(edits.map((e) => e.sectionKey));
  await release(
    row.id,
    keys.filter((k) => !touched.has(k)),
    edits.length ? undefined : "Revise: the note didn't call for changing any section. Try saying what to change.",
  );
  for (const e of edits) await deps.enqueueSection(e.sectionKey, sectionInstruction(e, note));
  deps.log?.(`newsletter-revise: ${row.id} → ${edits.map((e) => e.sectionKey).join(", ") || "no sections"}`);
  return { ok: true, revised: edits.map((e) => e.sectionKey) };
}
