/**
 * Put Whisper's punctuation back on its words.
 *
 * `timestamp_granularities: ["word"]` returns timed words with the
 * punctuation stripped ("wanted", "Then"), while the segments' `text` is the
 * properly punctuated sentence ("...wanted. Then, ..."). We store the words
 * as the source of truth, so without this nothing downstream — caption
 * cues, sentence snapping, the transcript editor — can tell where a
 * sentence ends.
 *
 * For each segment, the punctuated text is tokenised and aligned onto the
 * timed words inside the segment's span by their letters (case- and
 * punctuation-insensitive). Where the two agree one-to-one — nearly always —
 * every word simply takes its punctuated spelling. Where they don't (Whisper
 * occasionally splits/merges a token between the two outputs) an LCS
 * alignment keeps the matches and leaves the unmatched words as they were,
 * so timing is never touched and nothing is invented. Pure.
 */

export interface TimedWord {
  word: string;
  startSec: number;
  endSec: number;
}

export interface TextSegment {
  startSec: number;
  endSec: number;
  text: string;
}

/** The comparable core of a token: letters/digits only, lower-cased. */
export function wordKey(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Does this word end a sentence? (Also true for "?" and "!".) */
export function endsSentence(word: string): boolean {
  return /[.!?…]["')\]]*$/.test(word.trim());
}

/** Does this word end a clause (comma, semicolon, colon, dash)? */
export function endsClause(word: string): boolean {
  return /[,;:—–-]["')\]]*$/.test(word.trim());
}

/** Punctuation a caption style may hide: trailing . , ; : and quotes, but
 *  never ? or ! (they carry meaning on screen). */
export function stripCaptionPunctuation(word: string): string {
  return word.replace(/^["'“‘(\[]+/, "").replace(/[.,;:…"'”’)\]]+$/, "");
}

/** Longest common subsequence over two key arrays → index pairs. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Return a copy of `words` with each word's spelling taken from the
 * punctuated segment text where the two align. Timing is untouched.
 */
export function punctuateWords<W extends TimedWord>(words: W[], segments: TextSegment[]): W[] {
  if (words.length === 0 || segments.length === 0) return words;
  const out = words.map((w) => ({ ...w }));
  // Words are assigned to the segment their midpoint falls in; segments are
  // contiguous and ordered, so a single pass suffices.
  let wi = 0;
  for (const seg of segments) {
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const idxs: number[] = [];
    while (wi < out.length && (out[wi].startSec + out[wi].endSec) / 2 < seg.startSec) wi++;
    let k = wi;
    while (k < out.length && (out[k].startSec + out[k].endSec) / 2 < seg.endSec) idxs.push(k++);
    wi = k;
    if (idxs.length === 0) continue;

    const wordKeys = idxs.map((i) => wordKey(out[i].word));
    const tokenKeys = tokens.map(wordKey);
    if (wordKeys.length === tokenKeys.length && wordKeys.every((key, i) => key === tokenKeys[i])) {
      idxs.forEach((i, n) => (out[i].word = tokens[n]));
      continue;
    }
    for (const [a, b] of lcsPairs(wordKeys, tokenKeys)) {
      if (wordKeys[a].length > 0) out[idxs[a]].word = tokens[b];
    }
  }
  return out;
}

/** Whether a transcript's words still lack the punctuation its segments
 *  have — the cheap check the backfill and the pipeline use. */
export function needsPunctuation(words: TimedWord[], segments: TextSegment[]): boolean {
  if (words.length === 0) return false;
  const segHas = segments.some((s) => /[.!?,]/.test(s.text));
  const wordsHave = words.some((w) => /[.!?,]/.test(w.word));
  return segHas && !wordsHave;
}
