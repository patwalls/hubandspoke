/**
 * Transcribe a clip uploaded into the editor (an intro recorded separately),
 * so its words can be cut and captioned like the source's. The browser pulls
 * the audio out of the file itself and sends a small 16 kHz mono WAV, so this
 * is one Whisper call — no S3 download, no ffmpeg, quick enough to answer
 * inside the request. Same model and punctuation pass as the long-form
 * pipeline (src/jobs/tasks/whisper-pipeline.ts).
 */
import OpenAI from "openai";
import { punctuateWords } from "@/lib/transcripts/punctuate-words";

const WHISPER_MODEL = "whisper-1";
/** Whisper's upload cap is 25 MB; 16 kHz 16-bit mono is ~1.9 MB a minute. */
export const MAX_UPLOAD_AUDIO_BYTES = 24 * 1024 * 1024;

export interface UploadWord {
  text: string;
  startSec: number;
  endSec: number;
}

interface WhisperVerboseResponse {
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
}

let _openai: OpenAI | null = null;
function openai(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  return (_openai ??= new OpenAI());
}

export async function transcribeUploadAudio(audio: File): Promise<UploadWord[]> {
  const resp = (await openai().audio.transcriptions.create({
    file: audio,
    model: WHISPER_MODEL,
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
  })) as unknown as WhisperVerboseResponse;
  const words = (resp.words ?? []).map((w) => ({ word: w.word, startSec: Number(w.start), endSec: Number(w.end) }));
  const segments = (resp.segments ?? []).map((s) => ({ startSec: Number(s.start), endSec: Number(s.end), text: s.text.trim() }));
  return punctuateWords(words, segments)
    .map((w) => ({ text: w.word.trim().slice(0, 100), startSec: round3(w.startSec), endSec: round3(Math.max(w.endSec, w.startSec)) }))
    .filter((w) => w.text.length > 0);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
