import { readFileSync } from "fs";
import { join } from "path";

/**
 * Finds the parts of Hub & Spoke's own documentation that answer a question,
 * so the assistant reads a few relevant passages instead of the whole
 * 200 KB feature inventory on every question.
 *
 * Source: docs/features.md — one table row per feature (what it is, where it
 * lives, how it behaves), under "## Section" headings. The cleanup backlog at
 * the end is internal housekeeping and is skipped. Academy content is
 * searched separately (src/lib/assistant/tools.ts → search_help).
 *
 * Ranking is plain keyword overlap (title hits weigh more). It only decides
 * what the model gets to read; the model judges relevance and answers.
 */

export type HelpPassage = { section: string; title: string; text: string };

const SKIP_SECTIONS = /cleanup backlog/i;
const STOP = new Set(
  "a an and are as at be by can do does for from how i in is it my of on or our the this to we what when where which who why with you your".split(" "),
);

export function parseFeatureDoc(markdown: string): HelpPassage[] {
  const passages: HelpPassage[] = [];
  let section = "";
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (SKIP_SECTIONS.test(section) || !line.startsWith("| ") || /^\|\s*-{3}/.test(line)) continue;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (cells.length < 2 || /^feature$/i.test(cells[0])) continue;
    passages.push({ section, title: cells[0], text: cells.join(" — ") });
  }
  return passages;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Crude stem so "schedule" / "scheduling" / "scheduled" match. */
export function stem(word: string): string {
  const w = word.replace(/(ing|ed|es|s|e)$/, "");
  return w.length >= 3 ? w : word;
}

/**
 * Top passages by keyword overlap. Rare words count more than words that are
 * everywhere ("post", "content"), and a hit in the title counts extra.
 */
export function rankPassages<T extends { title: string; text: string }>(passages: T[], query: string, limit: number): T[] {
  const terms = [...new Set(tokenize(query).map(stem))];
  if (terms.length === 0 || passages.length === 0) return [];
  const docs = passages.map((p) => ({ p, title: new Set(tokenize(p.title).map(stem)), body: tokenize(p.text).map(stem) }));
  const idf = new Map(
    terms.map((t) => {
      const df = docs.filter((d) => d.title.has(t) || d.body.includes(t)).length;
      return [t, Math.log(1 + passages.length / (1 + df))];
    }),
  );
  return docs
    .map((d) => {
      let score = 0;
      for (const t of terms) {
        const hits = d.body.filter((w) => w === t).length;
        const weight = idf.get(t) ?? 0;
        if (hits > 0) score += weight * (1 + Math.log(hits));
        if (d.title.has(t)) score += weight * 2;
      }
      return { p: d.p, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.p);
}

let cache: HelpPassage[] | null = null;

/** docs/features.md, parsed once per server process. Missing file → no passages. */
export function featurePassages(): HelpPassage[] {
  if (cache) return cache;
  try {
    cache = parseFeatureDoc(readFileSync(join(process.cwd(), "docs", "features.md"), "utf8"));
  } catch {
    cache = [];
  }
  return cache;
}

export function searchFeatureDocs(query: string, limit = 5, maxChars = 2500): HelpPassage[] {
  return rankPassages(featurePassages(), query, limit).map((p) => ({
    ...p,
    text: p.text.length > maxChars ? `${p.text.slice(0, maxChars)}…` : p.text,
  }));
}
