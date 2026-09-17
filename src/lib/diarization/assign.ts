/**
 * Join diarizer turns onto Whisper words — pure, deterministic, tested.
 *
 * The diarizer's raw output is noisy in specific, observed ways:
 *   - zero-length / sub-100ms "turns" carrying a single stray word;
 *   - one- or two-word islands attributed to the other speaker in the middle
 *     of a sentence (backchannel "yeah", or plain jitter at a boundary);
 *   - turn boundaries that land mid-word, because its timestamps are coarser
 *     than Whisper's.
 * So this doesn't copy labels across; it votes by overlap, then smooths.
 */
import type { SpeakerTurn, TranscriptSpeaker } from "./types";

export interface TimedWord {
  word: string;
  startSec: number;
  endSec: number;
  speakerId?: string;
}

export interface TimedSegment {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
  speakerId?: string;
}

/** Turns shorter than this are diarizer noise, not speech. */
const MIN_TURN_SEC = 0.15;
/** A word with no overlapping turn borrows the nearest turn within this. */
const NEAREST_TURN_SEC = 1.0;
/** Islands at most this many words AND this long get absorbed… */
const ISLAND_MAX_WORDS = 2;
const ISLAND_MAX_SEC = 0.9;
/** …and a mid-segment speaker change only splits the segment when both
 *  sides are at least this many words (else it's noise; majority wins). */
const SPLIT_MIN_WORDS = 3;

/** Speaker id per word (same order/length as `words`). Null = unknowable. */
export function assignSpeakersToWords(
  words: TimedWord[],
  turns: SpeakerTurn[],
): Array<string | null> {
  const usable = turns
    .filter((t) => t.endSec - t.startSec >= MIN_TURN_SEC)
    .sort((a, b) => a.startSec - b.startSec);
  if (usable.length === 0) return words.map(() => null);

  const out: Array<string | null> = [];
  let cursor = 0; // turns are sorted and words are chronological → sweep
  for (const w of words) {
    while (cursor < usable.length - 1 && usable[cursor].endSec < w.startSec) cursor++;
    const overlapBySpeaker = new Map<string, number>();
    let nearest: { id: string; dist: number } | null = null;
    // Look a little either side of the cursor: turns can overlap each other.
    for (let i = Math.max(0, cursor - 2); i < usable.length; i++) {
      const t = usable[i];
      if (t.startSec > w.endSec + NEAREST_TURN_SEC) break;
      const overlap = Math.min(w.endSec, t.endSec) - Math.max(w.startSec, t.startSec);
      if (overlap > 0) {
        overlapBySpeaker.set(t.speakerId, (overlapBySpeaker.get(t.speakerId) ?? 0) + overlap);
      } else {
        const dist = Math.max(t.startSec - w.endSec, w.startSec - t.endSec);
        if (dist <= NEAREST_TURN_SEC && (!nearest || dist < nearest.dist)) {
          nearest = { id: t.speakerId, dist };
        }
      }
    }
    let best: string | null = null;
    let bestOverlap = 0;
    for (const [id, o] of overlapBySpeaker) {
      if (o > bestOverlap) {
        best = id;
        bestOverlap = o;
      }
    }
    out.push(best ?? nearest?.id ?? null);
  }

  fillUnknowns(out);
  absorbIslands(out, words);
  return out;
}

/** Give unlabeled words their nearest labeled neighbour's speaker. */
function fillUnknowns(ids: Array<string | null>): void {
  let last: string | null = null;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i]) last = ids[i];
    else if (last) ids[i] = last;
  }
  let next: string | null = null;
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i]) next = ids[i];
    else if (next) ids[i] = next;
  }
}

/**
 * A tiny run sandwiched between two runs of the SAME other speaker is
 * absorbed into them. Real interjections survive if they're longer than the
 * thresholds ("Wait, how much?" is 3 words); jitter doesn't.
 */
function absorbIslands(ids: Array<string | null>, words: TimedWord[]): void {
  let i = 0;
  while (i < ids.length) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[i]) j++;
    const before = i > 0 ? ids[i - 1] : null;
    const after = j + 1 < ids.length ? ids[j + 1] : null;
    const count = j - i + 1;
    const dur = words[j].endSec - words[i].startSec;
    if (before && before === after && before !== ids[i] && count <= ISLAND_MAX_WORDS && dur <= ISLAND_MAX_SEC) {
      for (let k = i; k <= j; k++) ids[k] = before;
      // Re-examine from the start of the run we just merged INTO: absorbing
      // one island can make its neighbour an island too.
      i = Math.max(0, i - 1);
      while (i > 0 && ids[i - 1] === before) i--;
      continue;
    }
    i = j + 1;
  }
}

/**
 * Label segments from their words. A segment whose words change speaker
 * part-way is SPLIT at the change (when both sides are substantial and the
 * segment's text tokens line up 1:1 with its words, so the punctuated text
 * can be cut at the same place); otherwise the majority speaker wins.
 */
export function labelSegments(
  segments: TimedSegment[],
  words: TimedWord[],
  wordSpeakers: Array<string | null>,
): TimedSegment[] {
  const out: TimedSegment[] = [];
  let w = 0;
  for (const seg of segments) {
    while (w < words.length && mid(words[w]) < seg.startSec) w++;
    const first = w;
    while (w < words.length && mid(words[w]) < seg.endSec) w++;
    const idxs = range(first, w);
    const ids = idxs.map((i) => wordSpeakers[i]);
    const known = ids.filter((x): x is string => !!x);
    if (known.length === 0) {
      out.push(stripSpeaker(seg));
      continue;
    }

    const runs = toRuns(ids);
    const tokens = seg.text.split(/\s+/).filter(Boolean);
    const splittable =
      runs.length > 1 &&
      tokens.length === idxs.length &&
      runs.every((r) => r.count >= SPLIT_MIN_WORDS && r.id);
    if (!splittable) {
      out.push({ ...stripSpeaker(seg), speakerId: majority(known) });
      continue;
    }
    let offset = 0;
    for (const run of runs) {
      const a = idxs[offset];
      const b = idxs[offset + run.count - 1];
      out.push({
        startSec: offset === 0 ? seg.startSec : words[a].startSec,
        endSec: offset + run.count === idxs.length ? seg.endSec : words[b].endSec,
        text: tokens.slice(offset, offset + run.count).join(" "),
        speakerId: run.id!,
      });
      offset += run.count;
    }
  }
  return out;
}

export function summarizeSpeakers(
  words: TimedWord[],
  wordSpeakers: Array<string | null>,
): Array<Pick<TranscriptSpeaker, "id" | "talkTimeSec" | "wordCount" | "firstSec">> {
  const by = new Map<string, { talkTimeSec: number; wordCount: number; firstSec: number }>();
  words.forEach((word, i) => {
    const id = wordSpeakers[i];
    if (!id) return;
    const s = by.get(id) ?? { talkTimeSec: 0, wordCount: 0, firstSec: word.startSec };
    s.talkTimeSec += Math.max(0, word.endSec - word.startSec);
    s.wordCount += 1;
    s.firstSec = Math.min(s.firstSec, word.startSec);
    by.set(id, s);
  });
  return [...by.entries()]
    .map(([id, s]) => ({ id, ...s, talkTimeSec: Math.round(s.talkTimeSec * 10) / 10 }))
    .sort((a, b) => a.firstSec - b.firstSec);
}

const mid = (w: TimedWord) => (w.startSec + w.endSec) / 2;
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

function stripSpeaker(seg: TimedSegment): TimedSegment {
  const { speaker: _speaker, speakerId: _speakerId, ...rest } = seg;
  void _speaker;
  void _speakerId;
  return rest;
}

function toRuns(ids: Array<string | null>): Array<{ id: string | null; count: number }> {
  const runs: Array<{ id: string | null; count: number }> = [];
  for (const id of ids) {
    const last = runs[runs.length - 1];
    if (last && last.id === id) last.count++;
    else runs.push({ id, count: 1 });
  }
  return runs;
}

function majority(ids: string[]): string {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
