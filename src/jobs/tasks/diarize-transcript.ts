// Worker-only (ffmpeg + OpenAI SDK), like whisper-pipeline.ts.
//
// Speaker detection for a Whisper transcript. See src/lib/diarization/types.ts
// for why this is a second model alongside Whisper rather than a replacement.
//
// One audio chunk per invocation. A diarize call on a 10-minute chunk takes
// ~4–5 MINUTES, so a whole podcast in one invocation would be an hour-long job
// that any deploy restarts from zero. Instead each invocation does one chunk,
// checkpoints into `transcripts.diarization`, and re-enqueues itself; a dyno
// restart costs at most the chunk in flight.
import { createReadStream } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import type { Task } from "graphile-worker";
import { eq, sql } from "drizzle-orm";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import OpenAI from "openai";
import { db } from "@/lib/db";
import { accounts, productionItems, transcripts } from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";
import { applyNames, labelTranscript } from "@/lib/diarization/finalize";
import {
  mapChunkLabels,
  mergeReferences,
  pickReferences,
} from "@/lib/diarization/identity";
import type { DiarizationState, SpeakerTurn } from "@/lib/diarization/types";
import { nameSpeakers, type SpeakerEvidence } from "@/lib/services/diarization/name-speakers";
import { downloadToFile } from "./descript-upload-helpers";

export interface DiarizeTranscriptPayload {
  productionItemId: string;
  /** Absent on the kickoff invocation; carried by every chunk invocation. */
  runId?: string;
  force?: boolean;
  /** Which serialized queue this run lives on — carried so the chunk chain
   *  stays on the queue it started on (backfills must never jump into the
   *  live queue). graphile's Job type doesn't expose the queue name. */
  queue?: "diarize" | "diarize-backfill";
}

const DIARIZE_MODEL = "gpt-4o-transcribe-diarize";
/** Generous: a 10-min chunk has taken 4m40s in testing. */
const API_TIMEOUT_MS = 12 * 60 * 1000;

interface DiarizedSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export const diarizeTranscriptTask: Task = async (rawPayload, helpers) => {
  const payload = rawPayload as DiarizeTranscriptPayload;
  const { productionItemId } = payload;
  const queue = payload.queue ?? "diarize";
  const log = (m: string) => helpers.logger.info(`diarize item=${productionItemId} ${m}`);

  const [t] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.productionItemId, productionItemId))
    .limit(1);
  if (!t) return log("no transcript; skipping");
  if (!t.words || t.words.length === 0) return log("transcript has no word timings; skipping");
  const chunks =
    t.audioChunks && t.audioChunks.length > 0
      ? t.audioChunks
      : t.audioS3Key
        ? [{ key: t.audioS3Key, startSec: 0 }]
        : [];
  if (chunks.length === 0) return log("no extracted audio; skipping");

  // ── Kickoff ───────────────────────────────────────────────────────────────
  if (!payload.runId) {
    if (t.diarizedAt && !payload.force) return log("already diarized; skipping");
    const runId = randomUUID();
    const state: DiarizationState = {
      status: "running",
      model: DIARIZE_MODEL,
      runId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      chunksTotal: chunks.length,
      chunksDone: 0,
      turns: [],
      references: [],
      usage: { audioTokens: 0, outputTokens: 0 },
    };
    // Writing a new runId is what retires any older run still in flight: its
    // next checkpoint is a conditional UPDATE on ITS runId and will miss.
    await db
      .update(transcripts)
      .set({ diarization: state, updatedAt: sql`now()` })
      .where(eq(transcripts.id, t.id));
    log(`start run=${runId} chunks=${chunks.length}`);
    await helpers.addJob(
      "diarize-transcript",
      { productionItemId, runId, queue },
      { jobKey: `diarize:${productionItemId}`, jobKeyMode: "replace", queueName: queue, maxAttempts: 5 },
    );
    return;
  }

  const state = t.diarization;
  if (!state || state.runId !== payload.runId) return log(`run ${payload.runId} superseded; bailing`);
  if (state.status === "done") return log("run already finished");

  try {
    if (state.chunksDone < state.chunksTotal) {
      const next = await diarizeOneChunk({ chunks, state, log });
      const saved = await checkpoint(t.id, next);
      if (!saved) return log(`run ${state.runId} superseded at checkpoint; bailing`);
      if (next.chunksDone < next.chunksTotal) {
        await helpers.addJob(
          "diarize-transcript",
          { productionItemId, runId: state.runId, queue },
          { jobKey: `diarize:${productionItemId}`, jobKeyMode: "replace", queueName: queue, maxAttempts: 5 },
        );
        return;
      }
      await finalize(t.id, productionItemId, next, log);
      return;
    }
    await finalize(t.id, productionItemId, state, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Stamp the error but leave status "running": graphile will retry this
    // chunk. Only the final attempt marks the run failed.
    const lastAttempt = helpers.job.attempts >= helpers.job.max_attempts;
    await checkpoint(t.id, {
      ...state,
      error: message.slice(0, 1000),
      ...(lastAttempt ? { status: "failed" as const, finishedAt: new Date().toISOString() } : {}),
    });
    throw err;
  }
};

/** Conditional on runId — returns false if a newer run has taken over. */
async function checkpoint(transcriptId: string, state: DiarizationState): Promise<boolean> {
  const rows = await db
    .update(transcripts)
    .set({ diarization: state, updatedAt: sql`now()` })
    .where(sql`${transcripts.id} = ${transcriptId} AND ${transcripts.diarization}->>'runId' = ${state.runId}`)
    .returning({ id: transcripts.id });
  return rows.length > 0;
}

async function diarizeOneChunk(args: {
  chunks: Array<{ key: string; startSec: number }>;
  state: DiarizationState;
  log: (m: string) => void;
}): Promise<DiarizationState> {
  const { chunks, state, log } = args;
  const index = state.chunksDone;
  const chunk = chunks[index];
  const workDir = await mkdtemp(join(tmpdir(), "diarize-"));
  try {
    // Chunk audio, plus whichever earlier chunks our reference clips live in.
    const localByIndex = new Map<number, string>();
    const fetchChunk = async (i: number) => {
      if (!localByIndex.has(i)) {
        const path = join(workDir, `chunk-${i}.ogg`);
        await downloadToFile(await getPresignedGetUrl(chunks[i].key, 3600), path);
        localByIndex.set(i, path);
      }
      return localByIndex.get(i)!;
    };
    const audioPath = await fetchChunk(index);

    const knownNames: string[] = [];
    const knownRefs: string[] = [];
    for (const ref of state.references) {
      const wav = join(workDir, `ref-${ref.speakerId}.wav`);
      await cutWav(await fetchChunk(ref.chunkIndex), ref.startSec, ref.durationSec, wav);
      knownNames.push(ref.speakerId);
      knownRefs.push(`data:audio/wav;base64,${(await readFile(wav)).toString("base64")}`);
    }

    const started = Date.now();
    const resp = (await new OpenAI().audio.transcriptions.create(
      {
        file: createReadStream(audioPath),
        model: DIARIZE_MODEL,
        response_format: "diarized_json",
        // Required by the API for audio over 30s.
        chunking_strategy: "auto",
        ...(knownNames.length > 0
          ? { known_speaker_names: knownNames, known_speaker_references: knownRefs }
          : {}),
      },
      { timeout: API_TIMEOUT_MS, maxRetries: 0 }, // graphile owns retries
    )) as unknown as {
      segments?: DiarizedSegment[];
      usage?: { input_token_details?: { audio_tokens?: number }; output_tokens?: number };
    };
    const segments = resp.segments ?? [];

    const existingIds = new Set(state.turns.map((x) => x.speakerId));
    const highest = Math.max(0, ...[...existingIds, ...knownNames].map((id) => Number(id.slice(1)) || 0));
    const { byLabel } = mapChunkLabels(segments.map((s) => s.speaker), knownNames, highest);

    const localTurns: SpeakerTurn[] = segments.map((s) => ({
      speakerId: byLabel.get(s.speaker)!,
      startSec: Number(s.start),
      endSec: Number(s.end),
    }));
    const turns = [
      ...state.turns,
      ...localTurns.map((x) => ({
        speakerId: x.speakerId,
        startSec: round3(x.startSec + chunk.startSec),
        endSec: round3(x.endSec + chunk.startSec),
      })),
    ];
    const talk = new Map<string, number>();
    for (const x of turns) talk.set(x.speakerId, (talk.get(x.speakerId) ?? 0) + (x.endSec - x.startSec));

    log(
      `chunk ${index + 1}/${state.chunksTotal} ok in ${Math.round((Date.now() - started) / 1000)}s segments=${segments.length} speakers=${[...new Set(localTurns.map((x) => x.speakerId))].join(",")} refsSent=${knownNames.length}`,
    );
    return {
      ...state,
      error: null,
      chunksDone: index + 1,
      turns,
      references: mergeReferences(state.references, pickReferences(localTurns, index), talk),
      usage: {
        audioTokens: state.usage.audioTokens + (resp.usage?.input_token_details?.audio_tokens ?? 0),
        outputTokens: state.usage.outputTokens + (resp.usage?.output_tokens ?? 0),
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function finalize(
  transcriptId: string,
  productionItemId: string,
  state: DiarizationState,
  log: (m: string) => void,
): Promise<void> {
  // Re-read: the transcript may have been edited (speaker renamed) mid-run.
  const [t] = await db.select().from(transcripts).where(eq(transcripts.id, transcriptId)).limit(1);
  if (!t || t.diarization?.runId !== state.runId) return log("superseded before finalize; bailing");

  let labelled = labelTranscript({
    words: t.words ?? [],
    segments: t.segments,
    turns: state.turns,
    previous: t.speakers,
  });

  if (labelled.speakers.length >= 2) {
    const naming = await nameSpeakers(await namingInput(productionItemId, labelled));
    if (naming.ok) {
      const byId = new Map(naming.speakers.map((s) => [s.id, s]));
      labelled = applyNames({
        ...labelled,
        speakers: labelled.speakers.map((s) => {
          const guess = byId.get(s.id);
          if (!guess) return s;
          // A name the user typed always wins over the model's.
          if (s.nameSource === "user") return { ...s, role: guess.role };
          return { ...s, role: guess.role, name: guess.name, nameSource: guess.name ? "llm" : null };
        }),
      });
    } else {
      // Naming is a nicety. "Speaker 1 / Speaker 2" is a fine result.
      log(`naming skipped: ${naming.failure.reason}`);
    }
  }

  const done: DiarizationState = {
    ...state,
    status: "done",
    error: null,
    finishedAt: new Date().toISOString(),
  };
  const rows = await db
    .update(transcripts)
    .set({
      words: labelled.words,
      segments: labelled.segments,
      speakers: labelled.speakers,
      diarization: done,
      diarizedAt: new Date(),
      updatedAt: sql`now()`,
    })
    .where(sql`${transcripts.id} = ${transcriptId} AND ${transcripts.diarization}->>'runId' = ${state.runId}`)
    .returning({ id: transcripts.id });
  if (rows.length === 0) return log("superseded at final write; bailing");
  log(
    `done speakers=${labelled.speakers.map((s) => `${s.id}:${s.name ?? "?"}(${s.role})`).join(" ")} audioTokens=${done.usage.audioTokens} outputTokens=${done.usage.outputTokens}`,
  );
}

async function namingInput(
  productionItemId: string,
  labelled: ReturnType<typeof labelTranscript>,
) {
  const [item] = await db
    .select({
      title: productionItems.title,
      description: productionItems.description,
      authorDisplayName: productionItems.authorDisplayName,
      accountName: accounts.displayName,
      accountHandle: accounts.handle,
    })
    .from(productionItems)
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  const total = labelled.speakers.reduce((n, s) => n + s.talkTimeSec, 0) || 1;
  const speakers: SpeakerEvidence[] = labelled.speakers.map((s) => ({
    id: s.id,
    talkSharePct: Math.round((s.talkTimeSec / total) * 100),
    samples: labelled.segments
      .filter((seg) => seg.speakerId === s.id && seg.text.trim().split(/\s+/).length >= 4)
      .slice(0, 6)
      .map((seg) => seg.text.trim()),
  }));
  const opening = labelled.segments
    .slice(0, 40)
    .map((seg) => `${seg.speakerId ?? "?"}: ${seg.text.trim()}`)
    .join("\n");
  return {
    title: item?.title ?? null,
    description: item?.description ?? null,
    channelName: item?.accountName ?? item?.accountHandle ?? null,
    authorName: item?.authorDisplayName ?? null,
    speakers,
    opening,
  };
}

function cutWav(input: string, startSec: number, durationSec: number, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegInstaller.path,
      ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(startSec), "-t", String(durationSec), "-i", input, "-ac", "1", "-ar", "16000", output],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg reference cut exited ${code}: ${stderr.slice(0, 300)}`)),
    );
  });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
