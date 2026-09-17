/**
 * Turn raw speaker turns + a Whisper transcript into the labelled transcript
 * we persist. Pure — the task, the "rename" API and the re-label-after-
 * re-transcription path all go through here.
 */
import {
  assignSpeakersToWords,
  labelSegments,
  summarizeSpeakers,
  type TimedSegment,
  type TimedWord,
} from "./assign";
import { speakerDisplayName, type SpeakerTurn, type TranscriptSpeaker } from "./types";

export interface LabelledTranscript {
  words: TimedWord[];
  segments: TimedSegment[];
  speakers: TranscriptSpeaker[];
}

/**
 * @param previous speakers from an earlier run — a name a USER set is carried
 *   over by id, so re-running detection never undoes a manual rename.
 */
export function labelTranscript(args: {
  words: TimedWord[];
  segments: TimedSegment[];
  turns: SpeakerTurn[];
  previous?: TranscriptSpeaker[] | null;
}): LabelledTranscript {
  const wordSpeakers = assignSpeakersToWords(args.words, args.turns);
  const stats = summarizeSpeakers(args.words, wordSpeakers);
  const prevById = new Map((args.previous ?? []).map((s) => [s.id, s]));

  const speakers: TranscriptSpeaker[] = stats.map((s) => {
    const prev = prevById.get(s.id);
    const keep = prev?.nameSource === "user";
    return {
      ...s,
      name: keep ? prev!.name : null,
      nameSource: keep ? "user" : null,
      role: prev?.role ?? "unknown",
    };
  });

  // One voice → labels are noise ("Speaker 1:" on every line of a monologue).
  // We still record the single speaker (it's a fact about the recording), but
  // leave words and segments unlabelled.
  if (speakers.length < 2) {
    return {
      words: args.words.map(({ speakerId: _drop, ...w }) => (void _drop, w)),
      segments: labelSegments(args.segments, args.words, args.words.map(() => null)),
      speakers,
    };
  }

  return applyNames({
    words: args.words.map((w, i) => {
      const { speakerId: _drop, ...rest } = w;
      void _drop;
      return wordSpeakers[i] ? { ...rest, speakerId: wordSpeakers[i]! } : rest;
    }),
    segments: labelSegments(args.segments, args.words, wordSpeakers),
    speakers,
  });
}

/** (Re)write every segment's display `speaker` from the speakers list — run
 *  after names change (LLM naming, user rename). */
export function applyNames(t: LabelledTranscript): LabelledTranscript {
  const nameById = new Map(
    t.speakers.map((s, i) => [s.id, speakerDisplayName(s, i + 1)]),
  );
  return {
    ...t,
    segments: t.segments.map((seg) => {
      const { speaker: _old, ...rest } = seg;
      void _old;
      const name = seg.speakerId ? nameById.get(seg.speakerId) : undefined;
      return name ? { ...rest, speaker: name } : rest;
    }),
  };
}
