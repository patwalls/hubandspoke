// Past issues, cut into the template's sections: "how The Orange Juice has
// read in the last few issues", one list per section key. The drafter and
// the per-section Regenerate get these as EXAMPLES next to each section's
// instructions — the examples teach the shape and the voice; the instructions
// only say what goes there — so an issue reads like the last ones instead of
// like a filled-in form. The editor's "Write it like a past issue" picks one
// of them by hand. Structural split on our own template headings (not content
// analysis). Pure.

import type { NewsletterTemplate } from "@/lib/newsletter-template";
import type { PastIssue } from "./sources";

/** Examples per section go into the prompt: keep each one readable, not the whole issue. */
export const EXAMPLE_CHAR_BUDGET = 1_800;
export const EXAMPLES_PER_SECTION = 3;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * An issue's plain text split by the template's headings, in template order:
 * `preamble` = everything before the first heading found (the intro), then
 * one entry per heading found, holding the text up to the next heading.
 * Headings are matched as whole lines (a line that is the heading, with any
 * `#`/emoji/punctuation noise). Pure; exported for tests.
 */
export function splitIssueSections(body: string, headings: string[]): { preamble: string; sections: Map<string, string> } {
  const wanted = headings.map(norm).filter(Boolean);
  const lines = body.split("\n");
  const hits: { heading: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = norm(lines[i].replace(/^#+\s*/, ""));
    if (!l || l.length > 80) continue;
    const h = wanted.find((w) => l === w || (l.startsWith(w) && l.length <= w.length + 4));
    if (h && !hits.some((x) => x.heading === h)) hits.push({ heading: h, line: i });
  }
  hits.sort((a, b) => a.line - b.line);
  const preamble = lines.slice(0, hits[0]?.line ?? lines.length).join("\n").trim();
  const sections = new Map<string, string>();
  hits.forEach((h, i) => {
    const end = hits[i + 1]?.line ?? lines.length;
    sections.set(h.heading, lines.slice(h.line + 1, end).join("\n").trim());
  });
  return { preamble, sections };
}

/**
 * Up to EXAMPLES_PER_SECTION past renderings of each template section, keyed
 * by section key, newest issue first. Headed sections come from their heading;
 * the first no-heading section (the intro) from the text before the first
 * heading. Sections that can't be located (a no-heading sign-off after the
 * last course) get none — the whole-issue examples still cover them. Pure.
 */
export function sectionExamples(issues: PastIssue[], template: NewsletterTemplate): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const headings = template.sections.map((s) => s.heading ?? "").filter(Boolean);
  const firstKey = template.sections[0];
  for (const issue of issues) {
    const { preamble, sections } = splitIssueSections(issue.body, headings);
    for (const sec of template.sections) {
      if (sec.kind === "sponsor") continue;
      let text: string | undefined;
      if (sec.heading) text = sections.get(norm(sec.heading));
      else if (sec === firstKey && headings.length) text = preamble;
      else if (!headings.length && sec === firstKey) text = issue.body;
      text = text?.trim();
      if (!text) continue;
      (out[sec.key] ??= []).push(text.length > EXAMPLE_CHAR_BUDGET ? `${text.slice(0, EXAMPLE_CHAR_BUDGET)}…` : text);
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice(0, EXAMPLES_PER_SECTION);
  return out;
}

/** The examples block for one section of the drafter's prompt (null when there are none). Pure. */
export function describeSectionExamples(examples: string[] | undefined, max = 2): string | null {
  if (!examples?.length) return null;
  return examples
    .slice(0, max)
    .map((e, i) => `   EXAMPLE ${i + 1} (a past issue — its shape and voice, not its content):\n${e.split("\n").map((l) => `   | ${l}`).join("\n")}`)
    .join("\n");
}

/** One section's past renderings with the issue they came from (the editor's "Write it like a past issue" picker). Pure. */
export function sectionExamplesFor(issues: PastIssue[], template: NewsletterTemplate, key: string, max = 8): { subject: string | null; publishedAt: string | null; text: string }[] {
  const sec = template.sections.find((s) => s.key === key);
  if (!sec || sec.kind === "sponsor") return [];
  const out: { subject: string | null; publishedAt: string | null; text: string }[] = [];
  for (const issue of issues) {
    const [one] = sectionExamples([issue], { ...template, sections: [...template.sections] })[key] ?? [];
    if (one) out.push({ subject: issue.subject, publishedAt: issue.publishedAt, text: one });
    if (out.length >= max) break;
  }
  return out;
}
