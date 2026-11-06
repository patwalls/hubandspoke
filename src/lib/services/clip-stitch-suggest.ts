import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, clipSections, productionItems } from "@/lib/db/schema";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import {
  locateSupportingMoments,
  needsStitchSuggest,
  type StitchSectionState,
  type SupportingMoment,
} from "@/lib/clip-stitch";
import { suggestSupportingQuotes } from "@/lib/clip-stitch-agent";

/** Clip stitching M3: a pre-v2 section's NULL `supporting_moments` means
 *  "never asked"; this asks once and stores the moments (`[]` for none). */

/** The section behind a clip idea (null when it has none). */
export async function sectionForClipIdea(clipIdeaId: string): Promise<
  (StitchSectionState & { id: string }) | null
> {
  const [row] = await db
    .select({
      id: clipSections.id,
      promptVersion: clipSections.promptVersion,
      supportingMoments: clipSections.supportingMoments,
      killedAt: clipSections.killedAt,
    })
    .from(clipIdeas)
    .innerJoin(clipSections, eq(clipSections.id, clipIdeas.clipSectionId))
    .where(eq(clipIdeas.id, clipIdeaId))
    .limit(1);
  return row ?? null;
}

export type StitchSuggestOutcome =
  | { status: "ok"; moments: number }
  | { status: "skip"; reason: string };

/** Worker-side, idempotent (writes only while still NULL). Throws on an API
 *  error so graphile retries; no transcript or no tool call stores `[]`. */
export async function suggestStitchForSection(
  sectionId: string,
  log: (m: string) => void = () => {},
  client?: Anthropic,
): Promise<StitchSuggestOutcome> {
  const [section] = await db
    .select({
      id: clipSections.id,
      pillarId: clipSections.pillarId,
      startSec: clipSections.startSec,
      endSec: clipSections.endSec,
      topic: clipSections.topic,
      summary: clipSections.summary,
      anchorQuote: clipSections.transcriptAnchorQuote,
      promptVersion: clipSections.promptVersion,
      supportingMoments: clipSections.supportingMoments,
      killedAt: clipSections.killedAt,
      title: productionItems.title,
    })
    .from(clipSections)
    .leftJoin(productionItems, eq(productionItems.id, clipSections.pillarId))
    .where(eq(clipSections.id, sectionId))
    .limit(1);
  if (!section) return { status: "skip", reason: "section-not-found" };
  if (!needsStitchSuggest(section)) return { status: "skip", reason: "not-needed" };

  const startSec = Number(section.startSec);
  const endSec = Number(section.endSec);
  const transcript = await getTranscriptForPrompt(section.pillarId);
  let moments: SupportingMoment[] = [];
  if (transcript) {
    const result = await suggestSupportingQuotes({
      title: section.title,
      section: { startSec, endSec, topic: section.topic, summary: section.summary, anchorQuote: section.anchorQuote },
      transcriptMarkdown: transcript.segmentsMarkdown,
      client,
    });
    if (!result.ok) {
      if (result.failure.reason === "llm-error") throw new Error(`stitch suggest: ${result.failure.message}`);
      log(`clip-section-stitch section=${sectionId} no tool call; storing none`);
    } else {
      moments = locateSupportingMoments({
        quotes: result.quotes,
        sectionStartSec: startSec,
        sectionEndSec: endSec,
        words: transcript.words,
        segments: transcript.segments,
      });
    }
  }

  await db
    .update(clipSections)
    .set({ supportingMoments: moments })
    .where(and(eq(clipSections.id, sectionId), isNull(clipSections.supportingMoments)));
  log(`clip-section-stitch section=${sectionId} moments=${moments.length}`);
  return { status: "ok", moments: moments.length };
}
