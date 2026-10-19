/**
 * "Correct all" (Descript): fix a transcript word's — or a phrase's —
 * spelling everywhere it appears, not just once. Words match on their
 * letters, ignoring case and the punctuation stuck to them ("Cloud," matches
 * "cloud"); each match keeps its own punctuation, so "Cloud," → "Claude,".
 * A phrase matches only as that run of words, so fixing "Cloud Code" leaves
 * a "cloud" said on its own alone. Like every correction this only changes
 * what captions say — never the cut. See `ClipEditDoc.wordEdits`.
 */
import { wordEditKey, type ClipEditDoc } from "./doc";
import type { EditorWord } from "./words";

/** A transcript word as the editor shows it: `text` is the current
 *  spelling (a correction, else what was transcribed). Words in different
 *  `block`s are never read as one phrase. */
export interface ShownWord {
  word: EditorWord;
  text: string;
  block?: string;
}

/** `"Cloud,"` → { lead: "", core: "Cloud", trail: "," } */
function split(text: string): { lead: string; core: string; trail: string } {
  const m = text.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
  return m ? { lead: m[1], core: m[2], trail: m[3] } : { lead: "", core: text, trail: "" };
}

const matchKey = (text: string) => split(text).core.toLowerCase();
const editKey = (w: ShownWord) => wordEditKey(w.word.startSec, w.word.mediaId);

/** Every run of `words` (in their order) that reads as `phrase`. Inside a
 *  run only the outer ends may carry punctuation — "cloud. Code" spans a
 *  sentence break and isn't "Cloud Code". */
function findRuns(words: ShownWord[], phrase: ShownWord[]): ShownWord[][] {
  const keys = phrase.map((w) => matchKey(w.text));
  if (keys.length === 0 || keys.some((k) => !k)) return [];
  const runs: ShownWord[][] = [];
  for (let i = 0; i + keys.length <= words.length; i++) {
    const run = words.slice(i, i + keys.length);
    const ok = run.every((w, j) => {
      if (matchKey(w.text) !== keys[j] || w.block !== run[0].block) return false;
      const { lead, trail } = split(w.text);
      return (j === 0 || !lead) && (j === run.length - 1 || !trail);
    });
    if (ok) runs.push(run);
  }
  return runs;
}

/** How many places "Correct all" would fix (this one included). A copied
 *  scene shows its words twice — those count once. */
export function countMatches(words: ShownWord[], phrase: ShownWord[]): number {
  return new Set(findRuns(words, phrase).map((run) => run.map(editKey).join("|"))).size;
}

/** Spread the typed words over a run of `n` words: one each; extra typed
 *  words go on the last, missing ones leave words empty (hidden). */
function spread(tokens: string[], n: number): string[] {
  return Array.from({ length: n }, (_, i) => (i < n - 1 ? (tokens[i] ?? "") : tokens.slice(n - 1).join(" ")));
}

/**
 * Respell `target` (a run of words) as `replacement` — and, with `all`,
 * every other run that reads the same. The target gets exactly what was
 * typed; the others get its letters inside their own outer punctuation.
 * Setting a word back to what was transcribed drops its correction.
 */
export function correctPhrase(
  doc: ClipEditDoc,
  words: ShownWord[],
  target: ShownWord[],
  replacement: string,
  opts: { all: boolean },
): ClipEditDoc {
  const typed = replacement.trim().split(/\s+/).filter(Boolean);
  if (target.length === 0 || typed.length === 0) return doc;
  const targetKeys = target.map(editKey).join("|");
  const runs = opts.all ? findRuns(words, target) : [target];
  const cores = spread(typed.map((t) => split(t).core || t), target.length);
  const wordEdits = { ...doc.wordEdits };
  for (const run of runs) {
    let values: string[];
    if (run.map(editKey).join("|") === targetKeys) values = spread(typed, run.length);
    else {
      // Outer punctuation goes on the first / last word that still says something.
      values = [...cores];
      const first = values.findIndex(Boolean);
      const last = values.length - 1 - [...values].reverse().findIndex(Boolean);
      values[first] = split(run[0].text).lead + values[first];
      values[last] = values[last] + split(run[run.length - 1].text).trail;
    }
    run.forEach((w, i) => {
      const k = editKey(w);
      if (values[i] === w.word.text) delete wordEdits[k];
      else wordEdits[k] = values[i];
    });
  }
  return { ...doc, wordEdits };
}
