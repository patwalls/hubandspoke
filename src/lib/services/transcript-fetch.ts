import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, syncLogs, transcripts } from "@/lib/db/schema";
import {
  extractShareSlug,
  fetchDescriptJob,
  fetchPublishedProject,
  publishComposition,
} from "@/lib/descript";
import { formatTimestamp, parseVtt, type VttCue } from "@/lib/utils/vtt";

const BASE_URL = "https://descriptapi.com/v1";
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 36; // 3 minutes

export class TranscriptFetchError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "no_descript_project"
      | "no_composition"
      | "publish_timeout"
      | "publish_failed"
      | "no_subtitles"
      | "parse_empty"
      | "unknown"
  ) {
    super(message);
    this.name = "TranscriptFetchError";
  }
}

function authHeader(): string {
  const token = process.env.DESCRIPT_API_TOKEN;
  if (!token) throw new Error("DESCRIPT_API_TOKEN not set");
  return `Bearer ${token}`;
}

// Descript's GET /projects/{id} isn't re-exported via the existing lib surface,
// so call it here. Returns the first composition id (what the publish endpoint
// wants) without inventing a new helper for a one-line call.
async function fetchFirstCompositionId(projectId: string): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/projects/${projectId}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    compositions?: Array<{ id: string }>;
  };
  return json.compositions?.[0]?.id ?? null;
}

async function waitForPublishJob(jobId: string): Promise<{
  shareUrl: string;
  compositionId: string | null;
}> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const job = await fetchDescriptJob(jobId);
    if (job.job_state === "running" || job.job_state === "pending" || job.job_state === "queued") {
      continue;
    }
    if (job.job_state !== "stopped" || job.result?.status !== "success") {
      throw new TranscriptFetchError(
        `Publish job ended in state=${job.job_state} status=${job.result?.status ?? "unknown"}`,
        "publish_failed"
      );
    }
    const shareUrl = job.result.share_url;
    if (!shareUrl) {
      throw new TranscriptFetchError("Publish job finished without share_url", "publish_failed");
    }
    return { shareUrl, compositionId: job.result.composition_id ?? null };
  }
  throw new TranscriptFetchError("Publish job did not complete within 3 minutes", "publish_timeout");
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface FetchResult {
  productionItemId: string;
  transcriptId: string;
  segmentCount: number;
  wordCount: number;
  durationSec: number;
  shareUrl: string;
}

/**
 * Publish the production item's Descript composition, fetch its published
 * WEBVTT subtitles, parse into segments, and upsert the transcripts row.
 * Gated by DESCRIPT_TRANSCRIPT_FETCH_LIVE — dry-run by default.
 */
export async function fetchDescriptTranscript(
  productionItemId: string
): Promise<FetchResult> {
  const live = process.env.DESCRIPT_TRANSCRIPT_FETCH_LIVE === "true";
  const startedAt = new Date();

  const [item] = await db
    .select({
      id: productionItems.id,
      descriptProjectId: productionItems.descriptProjectId,
      descriptCompositionId: productionItems.descriptCompositionId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);

  if (!item) {
    throw new TranscriptFetchError(`production_item ${productionItemId} not found`, "unknown");
  }
  if (!item.descriptProjectId) {
    throw new TranscriptFetchError(
      `production_item ${productionItemId} has no descriptProjectId`,
      "no_descript_project"
    );
  }

  let compositionId = item.descriptCompositionId;
  if (!compositionId) {
    compositionId = await fetchFirstCompositionId(item.descriptProjectId);
    if (!compositionId) {
      throw new TranscriptFetchError(
        `project ${item.descriptProjectId} has no compositions`,
        "no_composition"
      );
    }
    await db
      .update(productionItems)
      .set({ descriptCompositionId: compositionId })
      .where(eq(productionItems.id, productionItemId));
  }

  if (!live) {
    throw new TranscriptFetchError(
      "DESCRIPT_TRANSCRIPT_FETCH_LIVE is not set; aborting before publishing. Set DESCRIPT_TRANSCRIPT_FETCH_LIVE=true to actually fetch.",
      "unknown"
    );
  }

  try {
    const publish = await publishComposition({
      projectId: item.descriptProjectId,
      compositionId,
    });
    const { shareUrl } = await waitForPublishJob(publish.jobId);
    const slug = extractShareSlug(shareUrl);
    if (!slug) {
      throw new TranscriptFetchError(`Could not parse slug from ${shareUrl}`, "publish_failed");
    }

    const published = await fetchPublishedProject(slug);
    const rawVtt = published.subtitles;
    if (!rawVtt || rawVtt.trim().length === 0) {
      throw new TranscriptFetchError("Published project has no subtitles", "no_subtitles");
    }

    const segments: VttCue[] = parseVtt(rawVtt);
    if (segments.length === 0) {
      throw new TranscriptFetchError("VTT parser produced zero segments", "parse_empty");
    }

    const fullText = segments.map((s) => s.text).join(" ");
    const durationSec = segments[segments.length - 1].endSec;
    const wordCount = countWords(fullText);
    const publishedAt = new Date();

    const [row] = await db
      .insert(transcripts)
      .values({
        productionItemId,
        source: "descript",
        language: "en",
        rawVtt,
        fullText,
        segments,
        wordCount,
        durationSec: durationSec.toFixed(3),
        descriptPublishedSlug: slug,
        descriptShareUrl: shareUrl,
        descriptPublishedAt: publishedAt,
        fetchedAt: publishedAt,
        error: null,
      })
      .onConflictDoUpdate({
        target: transcripts.productionItemId,
        set: {
          source: "descript",
          language: "en",
          rawVtt,
          fullText,
          segments,
          wordCount,
          durationSec: durationSec.toFixed(3),
          descriptPublishedSlug: slug,
          descriptShareUrl: shareUrl,
          descriptPublishedAt: publishedAt,
          fetchedAt: publishedAt,
          error: null,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: transcripts.id });

    await db.insert(syncLogs).values({
      syncType: "transcript-fetch",
      status: "success",
      itemsCreated: 1,
      startedAt,
      completedAt: new Date(),
    });

    return {
      productionItemId,
      transcriptId: row.id,
      segmentCount: segments.length,
      wordCount,
      durationSec,
      shareUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(syncLogs).values({
      syncType: "transcript-fetch",
      status: "error",
      errorMessage: message,
      startedAt,
      completedAt: new Date(),
    });
    throw err;
  }
}

export interface TranscriptPromptPayload {
  fullText: string;
  segmentsMarkdown: string;
  durationSec: number;
}

/**
 * The single seam between transcript ingestion (Stage 1) and the clip-idea
 * agent (Stage 2). Returns null when no transcript exists for the item.
 *
 * segmentsMarkdown formats each cue as `[MM:SS] speaker: text` on its own line
 * so the agent can cite explicit timestamps when proposing clip boundaries.
 */
export async function getTranscriptForPrompt(
  productionItemId: string
): Promise<TranscriptPromptPayload | null> {
  const [row] = await db
    .select({
      fullText: transcripts.fullText,
      segments: transcripts.segments,
      durationSec: transcripts.durationSec,
    })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, productionItemId))
    .limit(1);

  if (!row) return null;

  const segmentsMarkdown = row.segments
    .map((s) => {
      const ts = formatTimestamp(s.startSec);
      return s.speaker ? `[${ts}] ${s.speaker}: ${s.text}` : `[${ts}] ${s.text}`;
    })
    .join("\n");

  return {
    fullText: row.fullText,
    segmentsMarkdown,
    durationSec: Number(row.durationSec ?? 0),
  };
}
