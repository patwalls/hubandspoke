/**
 * Speaker detection ("diarization") data shapes.
 *
 * Why two models: Whisper gives us word-level timestamps but no idea who is
 * talking; OpenAI's diarizing transcriber knows who is talking but returns
 * only coarse segments, no word timings, and accepts no vocabulary prompt (so
 * its TEXT is worse than Whisper's for names). We therefore keep Whisper's
 * text + timings as canonical and use the diarizer for one thing only — WHO —
 * joining the two by time (assign.ts).
 *
 * Identity: a speaker is a stable id ("S1", "S2"…) for the life of a
 * transcript. The human-readable name lives in `TranscriptSpeaker.name` and
 * can change (LLM guess → user rename) without touching the words.
 */

/** One stretch of speech by one speaker, on the SOURCE timeline (seconds). */
export interface SpeakerTurn {
  speakerId: string;
  startSec: number;
  endSec: number;
}

export type SpeakerRole = "host" | "guest" | "narrator" | "unknown";

export interface TranscriptSpeaker {
  id: string;
  /** Display name. Null → shown as "Speaker N". */
  name: string | null;
  /** Who set `name`. A user's rename is never overwritten by a re-run. */
  nameSource: "llm" | "user" | null;
  role: SpeakerRole;
  talkTimeSec: number;
  wordCount: number;
  /** Where this speaker first talks — orders the "Speaker N" numbering. */
  firstSec: number;
}

/** A clean clip of one speaker, sent to later chunks so the diarizer keeps
 *  calling them the same thing. Times are LOCAL to `chunkIndex`'s audio. */
export interface SpeakerReference {
  speakerId: string;
  chunkIndex: number;
  startSec: number;
  durationSec: number;
}

/** Persisted on `transcripts.diarization` — job state + raw turns (kept so a
 *  re-transcription can be re-labelled without paying to diarize again). */
export interface DiarizationState {
  status: "running" | "done" | "failed";
  model: string;
  /** Guards against two runs interleaving on one transcript. */
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  chunksTotal: number;
  chunksDone: number;
  turns: SpeakerTurn[];
  references: SpeakerReference[];
  usage: { audioTokens: number; outputTokens: number };
}

export function speakerDisplayName(
  speaker: Pick<TranscriptSpeaker, "id" | "name">,
  ordinal: number,
): string {
  return speaker.name?.trim() || `Speaker ${ordinal}`;
}
