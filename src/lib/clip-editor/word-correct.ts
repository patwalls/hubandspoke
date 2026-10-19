/**
 * "Correct all" (Descript): fix a transcript word's spelling everywhere it
 * appears, not just once. Words match on their letters, ignoring case and
 * the punctuation stuck to them ("Cloud," matches "cloud"); each match keeps
 * its own punctuation, so "Cloud," → "Claude,". Like every correction this
 * only changes what captions say — never the cut. See `ClipEditDoc.wordEdits`.
 */
import { wordEditKey, type ClipEditDoc } from "./doc";
import type { EditorWord } from "./words";

/** A transcript word as the editor shows it: `text` is the current
 *  spelling (a correction, else what was transcribed). */
export interface ShownWord {
  word: EditorWord;
  text: string;
}

/** `"Cloud,"` → { lead: "", core: "Cloud", trail: "," } */
function split(text: string): { lead: string; core: string; trail: string } {
  const m = text.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
  return m ? { lead: m[1], core: m[2], trail: m[3] } : { lead: "", core: text, trail: "" };
}

const matchKey = (text: string) => split(text).core.toLowerCase();

/** How many words "Correct all" would touch for `text` (including itself). */
export function countMatches(words: ShownWord[], text: string): number {
  const key = matchKey(text);
  if (!key) return 0;
  // A copied scene shows a word twice — count it once.
  const seen = new Set<string>();
  for (const w of words) if (matchKey(w.text) === key) seen.add(wordEditKey(w.word.startSec, w.word.mediaId));
  return seen.size;
}

/**
 * Respell every word that matches `target` as `replacement`. The target
 * itself gets `replacement` exactly as typed; the others get its letters
 * inside their own punctuation. Setting a word back to what was transcribed
 * drops its correction.
 */
export function correctAll(doc: ClipEditDoc, words: ShownWord[], target: ShownWord, replacement: string): ClipEditDoc {
  const key = matchKey(target.text);
  const typed = replacement.trim();
  const { core } = split(typed);
  if (!key || !core) return doc;
  const targetKey = wordEditKey(target.word.startSec, target.word.mediaId);
  const wordEdits = { ...doc.wordEdits };
  for (const w of words) {
    if (matchKey(w.text) !== key) continue;
    const k = wordEditKey(w.word.startSec, w.word.mediaId);
    const { lead, trail } = split(w.text);
    const value = k === targetKey ? typed : `${lead}${core}${trail}`;
    if (value === w.word.text) delete wordEdits[k];
    else wordEdits[k] = value;
  }
  return { ...doc, wordEdits };
}
