// Proofread: exact find → replace fixes for typos, grammar, doubled words,
// broken Markdown and inconsistent names/numbers across a draft — never a
// rewrite (that's Regenerate / the AI review). One Sonnet call with a forced
// tool; each fix is applied only where `find` occurs exactly once in its
// section, so a fix can never land somewhere else. Fail-soft.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { NewsletterSection } from "@/lib/newsletter-template";

const MODEL = "claude-sonnet-5-5";

export interface ProofreadFix {
  sectionKey: string;
  find: string;
  replace: string;
  why: string;
}

const Output = z.object({
  fixes: z.array(z.object({ section_key: z.string(), find: z.string().min(1).max(400), replace: z.string().max(400), why: z.string().min(1).max(160) })).max(30),
});

const TOOL: Anthropic.Tool = {
  name: "submit_fixes",
  description: "Exact text fixes for the draft, each as the text to find (verbatim, as it appears, including Markdown) and its replacement.",
  input_schema: {
    type: "object",
    properties: {
      fixes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            section_key: { type: "string" },
            find: { type: "string", description: "The exact text as it appears in that section (short: a few words around the problem), unique within the section." },
            replace: { type: "string", description: "The corrected text. Same Markdown, same links." },
            why: { type: "string", description: "A few words: typo, grammar, doubled word, inconsistent name, broken link syntax…" },
          },
          required: ["section_key", "find", "replace", "why"],
        },
      },
    },
    required: ["fixes"],
  },
};

/** Keep only fixes whose `find` occurs exactly once in their section. Pure; exported for tests. */
export function applicableFixes(fixes: ProofreadFix[], sections: NewsletterSection[]): ProofreadFix[] {
  const byKey = new Map(sections.map((s) => [s.key, s.markdown]));
  return fixes.filter((f) => {
    const md = byKey.get(f.sectionKey);
    if (!md || f.find === f.replace) return false;
    const first = md.indexOf(f.find);
    return first >= 0 && md.indexOf(f.find, first + 1) < 0;
  });
}

/** Apply fixes to the sections (each once). Pure; exported for tests. */
export function applyFixes(sections: NewsletterSection[], fixes: ProofreadFix[]): NewsletterSection[] {
  return sections.map((s) => {
    let md = s.markdown;
    for (const f of fixes) if (f.sectionKey === s.key && md.indexOf(f.find) >= 0 && md.indexOf(f.find) === md.lastIndexOf(f.find)) md = md.replace(f.find, f.replace);
    return md === s.markdown ? s : { ...s, markdown: md };
  });
}

export type ProofreadResult = { ok: true; fixes: ProofreadFix[] } | { ok: false; failure: "llm-error" | "llm-empty"; message?: string };

export async function proofreadSections(
  args: { sections: NewsletterSection[]; sectionNames: Record<string, string>; subject: string | null; styleNotes?: string | null },
  client: Anthropic = new Anthropic(),
): Promise<ProofreadResult> {
  const body = args.sections
    .filter((s) => s.markdown.trim())
    .map((s) => `### section_key: ${s.key}${args.sectionNames[s.key] ? ` (${args.sectionNames[s.key]})` : ""}\n${s.markdown}`)
    .join("\n\n");
  const prompt = [
    "Proofread this newsletter draft. Find ONLY objective errors: typos, misspellings, grammar slips, doubled words, missing/extra punctuation, broken Markdown (unclosed ** or links), a name or number spelled two ways in the issue, a link whose text doesn't match where it points. Do NOT change voice, tone, slang, sentence fragments, casual punctuation, emoji or deliberate style — this newsletter is written the way it talks.",
    args.styleNotes?.trim() ? `How it's written on purpose (leave this alone):\n${args.styleNotes.trim()}` : null,
    `Subject: ${args.subject ?? ""}`,
    body,
    "For each error call submit_fixes with the exact text to find (verbatim, a few words, unique in its section) and the replacement. No errors → an empty list.",
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const message = await client.messages.create({ model: MODEL, max_tokens: 3_000, tools: [TOOL], messages: [{ role: "user", content: prompt }] });
    let use = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!use) {
      // Answered in prose: one nudge to use the tool.
      const again = await client.messages.create({
        model: MODEL,
        max_tokens: 3_000,
        tools: [TOOL],
        messages: [{ role: "user", content: prompt }, { role: "assistant", content: message.content }, { role: "user", content: "Call submit_fixes with the result." }],
      });
      use = again.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    }
    const parsed = use ? Output.safeParse(use.input) : null;
    if (!parsed?.success) return { ok: false, failure: "llm-empty" };
    const fixes = applicableFixes(parsed.data.fixes.map((f) => ({ sectionKey: f.section_key, find: f.find, replace: f.replace, why: f.why })), args.sections);
    return { ok: true, fixes };
  } catch (err) {
    return { ok: false, failure: "llm-error", message: (err as Error).message };
  }
}
