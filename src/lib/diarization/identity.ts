/**
 * Keeping "who" consistent across audio chunks.
 *
 * We diarize long audio in ~10-minute chunks, and the diarizer names speakers
 * afresh in each one (A, B, …) — chunk 2's "A" has no relation to chunk 1's.
 * Its answer to that is reference clips: send 2–10s of each known speaker
 * with a name, and it uses those names. This module decides (a) how the
 * labels in a chunk's response map to our stable ids, and (b) which stretch
 * of audio makes the best reference for each speaker.
 */
import type { SpeakerReference, SpeakerTurn } from "./types";

/** API limit. */
export const MAX_REFERENCES = 4;
const REF_MIN_SEC = 2;
const REF_MAX_SEC = 8;
/** Trim this much off each end of a turn — edges are where crosstalk and
 *  the other speaker's tail live. */
const REF_EDGE_PAD_SEC = 0.4;

export const speakerIdFor = (n: number) => `S${n}`;

/**
 * Map one chunk's response labels to stable ids. Labels we sent as known
 * names come back verbatim and keep their id; anything else is a speaker we
 * haven't met, and gets the next id. `nextIndex` = how many ids exist so far.
 */
export function mapChunkLabels(
  labels: string[],
  knownIds: string[],
  nextIndex: number,
): { byLabel: Map<string, string>; nextIndex: number } {
  const byLabel = new Map<string, string>();
  let n = nextIndex;
  for (const label of labels) {
    if (byLabel.has(label)) continue;
    if (knownIds.includes(label)) byLabel.set(label, label);
    else byLabel.set(label, speakerIdFor(++n));
  }
  return { byLabel, nextIndex: n };
}

/**
 * The best reference clip for each speaker in one chunk: the middle of their
 * longest turn. `turns` are LOCAL to the chunk. Speakers with no turn of at
 * least REF_MIN_SEC (after padding) get none — a bad reference is worse than
 * no reference.
 */
export function pickReferences(
  turns: SpeakerTurn[],
  chunkIndex: number,
): SpeakerReference[] {
  const longest = new Map<string, SpeakerTurn>();
  for (const t of turns) {
    const cur = longest.get(t.speakerId);
    if (!cur || t.endSec - t.startSec > cur.endSec - cur.startSec) longest.set(t.speakerId, t);
  }
  const refs: SpeakerReference[] = [];
  for (const [speakerId, t] of longest) {
    const usable = t.endSec - t.startSec - 2 * REF_EDGE_PAD_SEC;
    if (usable < REF_MIN_SEC) continue;
    const durationSec = Math.min(REF_MAX_SEC, usable);
    const center = (t.startSec + t.endSec) / 2;
    refs.push({
      speakerId,
      chunkIndex,
      startSec: round3(center - durationSec / 2),
      durationSec: round3(durationSec),
    });
  }
  return refs;
}

/**
 * Merge a chunk's candidate references into the running set: a speaker keeps
 * their existing reference unless the new one is meaningfully longer (their
 * first chunk may only have had a short interjection). Capped at the API
 * limit, keeping the speakers who talk the most.
 */
export function mergeReferences(
  existing: SpeakerReference[],
  candidates: SpeakerReference[],
  talkTimeBySpeaker: Map<string, number>,
): SpeakerReference[] {
  const by = new Map(existing.map((r) => [r.speakerId, r]));
  for (const c of candidates) {
    const cur = by.get(c.speakerId);
    if (!cur || c.durationSec > cur.durationSec + 1.5) by.set(c.speakerId, c);
  }
  return [...by.values()]
    .sort(
      (a, b) =>
        (talkTimeBySpeaker.get(b.speakerId) ?? 0) - (talkTimeBySpeaker.get(a.speakerId) ?? 0),
    )
    .slice(0, MAX_REFERENCES);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
