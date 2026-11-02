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
 * Apply the sibling clips' spelling fixes to `doc` (a doc that has no
 * corrections of its own yet). `siblings` oldest first — a later fix of the
 * same phrase wins. Returns the new doc and the fixes that changed a word
 * inside this clip (what the editor tells the person).
 */
export function carrySiblingFixes(
  doc: ClipEditDoc,
  words: EditorWord[],
  siblings: ClipEditDoc[],
): { doc: ClipEditDoc; carried: string[] } {
  if (words.length === 0 || siblings.length === 0) return { doc, carried: [] };
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
  if (latest.size === 0) return { doc, carried: [] };

  const shown: ShownWord[] = words.map((word) => ({ word, text: word.text }));
  let out = doc;
  for (const fix of latest.values()) {
    const target = fix.target.map((w) => shown[byKey.get(wordEditKey(w.startSec))!]);
    out = correctPhrase(out, shown, target, fix.replacement, { all: true });
  }

  const inClip = (w: EditorWord) => out.sections.some((s) => isWordInRange(w, s));
  const carried = new Set<string>();
  for (const fix of latest.values()) {
    const said = fix.target.map((w) => letters(w.text)).join(" ");
    const hit = words.some((w, i) => {
      const k = wordEditKey(w.startSec);
      if (!(k in out.wordEdits) || !inClip(w)) return false;
      // The first word of a run that reads as this phrase.
      const run = words.slice(i, i + fix.target.length).map((x) => letters(x.text)).join(" ");
      return run === said;
    });
    if (hit) carried.add(fix.replacement.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
  }
  return { doc: out, carried: [...carried] };
}
