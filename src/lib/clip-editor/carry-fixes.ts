/**
 * Fix a name once per video: a new clip edit starts with the spelling fixes
 * teammates already made in OTHER clips cut from the same source video.
 *
 * Every clip of one source shares that source's transcript, and a
 * correction is keyed by the word's source time (`wordEditKey`), so a
 * sibling doc's `wordEdits` point straight at words in our own transcript.
 * Each run of consecutive corrected words becomes one phrase fix ("chat gpt"
 * → "ChatGPT"), which is then applied with "Correct all" (`correctPhrase`)
 * — so it lands everywhere the video says it, punctuation kept, phrases only
 * matched as phrases.
 *
 * A doc that already has corrections of its own (fix-names-once M2: a clip
 * someone opened before the fix was made elsewhere) keeps every one of them —
 * a sibling's fix only fills words this clip hasn't corrected. `added` is
 * exactly what would change, so the editor can offer it as one click instead
 * of rewriting a doc someone already worked on.
 *
 * Fixes that only change case or punctuation ("so" → "So,") are caption
 * styling for one spot, not a spelling — they are never carried. Uploaded
 * clips' corrections (`<mediaId>@ms` keys) belong to that clip's own file
 * and are skipped. Captions only: like every correction this never touches
 * the cut.
 */
import { wordEditKey, type ClipEditDoc } from "./doc";
import { correctPhrase, type ShownWord } from "./word-correct";
import { isWordInRange, type EditorWord } from "./words";

/** What a run of words reads as, ignoring case and punctuation but keeping
 *  word breaks — "chat gpt" → "ChatGPT" is a fix, "so" → "So," is not. */
const letters = (s: string) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .join(" ");

interface PhraseFix {
  target: EditorWord[];
  replacement: string;
}

/** One sibling doc's corrections, grouped into runs of consecutive words. */
function phraseFixes(sibling: ClipEditDoc, words: EditorWord[], byKey: Map<string, number>): PhraseFix[] {
  const edited = Object.keys(sibling.wordEdits)
    .filter((k) => !k.includes("@"))
    .map((k) => byKey.get(k))
    .filter((i): i is number => i !== undefined)
    .sort((a, b) => a - b);
  const fixes: PhraseFix[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const target = run.map((i) => words[i]);
    const replacement = target
      .map((w) => sibling.wordEdits[wordEditKey(w.startSec)])
      .filter(Boolean)
      .join(" ")
      .trim();
    const said = target.map((w) => w.text).join(" ");
    if (replacement && letters(replacement) !== letters(said)) fixes.push({ target, replacement });
    run = [];
  };
  for (const i of edited) {
    if (run.length > 0 && i !== run[run.length - 1] + 1) flush();
    run.push(i);
  }
  flush();
  return fixes;
}

/**
 * Apply the sibling clips' spelling fixes to `doc`. `siblings` oldest first —
 * a later fix of the same phrase wins; `doc`'s own corrections always win.
 * Returns the new doc, the corrections it added (`added`), and the fixes that
 * changed a word inside this clip (what the editor tells the person).
 */
export function carrySiblingFixes(
  doc: ClipEditDoc,
  words: EditorWord[],
  siblings: ClipEditDoc[],
): { doc: ClipEditDoc; carried: string[]; added: Record<string, string> } {
  const none = { doc, carried: [], added: {} };
  if (words.length === 0 || siblings.length === 0) return none;
  const byKey = new Map(words.map((w, i) => [wordEditKey(w.startSec), i]));
  // Latest fix per phrase (by what was said), so two clips that spelled a
  // name differently don't both apply — the newest spelling wins.
  const latest = new Map<string, PhraseFix>();
  for (const sibling of siblings) {
    for (const fix of phraseFixes(sibling, words, byKey)) {
      const said = fix.target.map((w) => letters(w.text)).join(" ");
      latest.delete(said);
      latest.set(said, fix);
    }
  }
  if (latest.size === 0) return none;

  const shown: ShownWord[] = words.map((word) => ({ word, text: word.text }));
  let out = doc;
  for (const fix of latest.values()) {
    const target = fix.target.map((w) => shown[byKey.get(wordEditKey(w.startSec))!]);
    out = correctPhrase(out, shown, target, fix.replacement, { all: true });
  }
  // This clip's own corrections win over anything a sibling did.
  const own = doc.wordEdits;
  const added: Record<string, string> = {};
  for (const [k, v] of Object.entries(out.wordEdits)) if (!(k in own)) added[k] = v;
  if (Object.keys(added).length === 0) return none;
  out = { ...out, wordEdits: { ...added, ...own } };

  const inClip = (w: EditorWord) => out.sections.some((s) => isWordInRange(w, s));
  const carried = new Set<string>();
  for (const fix of latest.values()) {
    const said = fix.target.map((w) => letters(w.text)).join(" ");
    const hit = words.some((w, i) => {
      const k = wordEditKey(w.startSec);
      if (!(k in added) || !inClip(w)) return false;
      // The first word of a run that reads as this phrase.
      const run = words.slice(i, i + fix.target.length).map((x) => letters(x.text)).join(" ");
      return run === said;
    });
    if (hit) carried.add(fix.replacement.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
  }
  return { doc: out, carried: [...carried], added };
}

/**
 * Brand spellings (fix-names-once M3): a name the team fixed in clips of TWO
 * OR MORE different videos of a brand ("cloud" → "Claude") is offered on any
 * clip of that brand — never applied on its own, since a word that is a name
 * in one video can be a plain word in another. The two-video bar is the same
 * idea as Descript's glossary (a word corrected 3+ times gets learned): one
 * video's fix is that video's business; two videos make it the brand's.
 */
export interface BrandSpelling {
  /** What the transcript says, lowercased, punctuation stripped ("chat gpt"). */
  said: string;
  /** The team's spelling, newest wins ("ChatGPT"). */
  replacement: string;
  /** How many different videos it was fixed in. */
  videos: number;
}

/** Learn the brand's spellings from clip edits of its videos. `edits` oldest
 *  first; each carries the words of its own source's transcript. */
export function learnBrandSpellings(
  edits: { sourceId: string; doc: ClipEditDoc; words: EditorWord[] }[],
  minVideos = 2,
): BrandSpelling[] {
  const seen = new Map<string, { replacement: string; sources: Set<string> }>();
  for (const { sourceId, doc, words } of edits) {
    if (words.length === 0) continue;
    const byKey = new Map(words.map((w, i) => [wordEditKey(w.startSec), i]));
    for (const fix of phraseFixes(doc, words, byKey)) {
      const said = fix.target.map((w) => letters(w.text)).join(" ");
      if (!said) continue;
      const entry = seen.get(said) ?? { replacement: fix.replacement, sources: new Set<string>() };
      entry.replacement = fix.replacement.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      entry.sources.add(sourceId);
      seen.set(said, entry);
    }
  }
  return [...seen.entries()]
    .filter(([, e]) => e.sources.size >= minVideos && e.replacement)
    .map(([said, e]) => ({ said, replacement: e.replacement, videos: e.sources.size }));
}

/**
 * Turn brand spellings into "sibling" docs keyed to THIS transcript — the
 * first place this video says each one — so `carrySiblingFixes` applies them
 * with the same "Correct all" rules (phrase only, punctuation kept, the
 * clip's own corrections win). Spellings this video never says are dropped.
 */
export function brandSpellingDocs(
  spellings: BrandSpelling[],
  words: EditorWord[],
  base: ClipEditDoc,
): ClipEditDoc[] {
  const said = words.map((w) => letters(w.text));
  const out: ClipEditDoc[] = [];
  for (const s of spellings) {
    const parts = s.said.split(" ");
    const at = said.findIndex((_, i) => parts.every((p, j) => said[i + j] === p));
    if (at < 0) continue;
    // Keep this spot's own punctuation ("rourke." → "Rork.").
    const lead = words[at].text.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? "";
    const trail = words[at + parts.length - 1].text.match(/[^\p{L}\p{N}]*$/u)?.[0] ?? "";
    const wordEdits: Record<string, string> = {};
    parts.forEach((_, j) => {
      wordEdits[wordEditKey(words[at + j].startSec)] = j === 0 ? lead + s.replacement + trail : "";
    });
    out.push({ ...base, wordEdits });
  }
  return out;
}
