// Eval harness for Splice V7. Runs the agent end-to-end against a list of
// pillar IDs without writing to the DB, then reports anchor-resolution
// telemetry per idea + an aggregate pass rate.
//
// Usage:
//   tsx --env-file=.env.local scripts/eval-splice-v7.ts <pillarId> [<pillarId> ...]
//
// Output: a per-pillar table (hook | anchor quote | picked range | final
// range | found | inside | snapped) plus a final aggregate "% of ideas with
// final range containing anchor". Target: 100%, since ideas without a valid
// anchor are dropped before this metric is computed (so the only way to drop
// below 100% is if generateClipIdeas() failed to recover after retry).

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { productionItems } from "../src/lib/db/schema";
import { getTranscriptForPrompt } from "../src/lib/services/whisper-transcribe";
import { topShortFormPerformers } from "../src/lib/db/queries";
import {
  generateClipIdeas,
  PROMPT_VERSION,
  GENERATED_BY,
  type BlueprintRow,
  type PerfRow,
} from "../src/lib/clip-idea-agent";

const SHORT_FORM_PLATFORMS = ["YouTube Shorts", "Instagram Reel", "TikTok"];
const PREFERRED_CLIP_FORMAT_FOR_BLUEPRINT = "Reel: Repackage Section w/ Hook";

function isShortForm(platform: string[] | null): boolean {
  if (!platform) return false;
  return platform.some((p) => SHORT_FORM_PLATFORMS.includes(p));
}

function fmtTs(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

interface PillarEvalResult {
  pillarId: string;
  pillarTitle: string | null;
  ideasReturned: number;
  diagnostics: Awaited<ReturnType<typeof generateClipIdeas>>["diagnostics"];
}

async function evalPillar(pillarId: string): Promise<PillarEvalResult | null> {
  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      format: productionItems.format,
      platform: productionItems.platform,
      brand: productionItems.brand,
    })
    .from(productionItems)
    .where(eq(productionItems.id, pillarId))
    .limit(1);

  if (!item) {
    console.error(`! pillar ${pillarId} not found`);
    return null;
  }

  const transcript = await getTranscriptForPrompt(pillarId);
  if (!transcript) {
    console.error(`! pillar ${pillarId} has no transcript`);
    return null;
  }
  if (transcript.words.length === 0) {
    console.error(
      `! pillar ${pillarId} (${item.title}) has no word-level transcript — V7 anchor matching cannot run. Re-transcribe first.`,
    );
    return null;
  }

  const derivativeRows = await db
    .select({
      title: productionItems.title,
      platform: productionItems.platform,
      format: productionItems.format,
      views: productionItems.views,
      hook: productionItems.hook,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.pillarContentItemId, pillarId),
        isNotNull(productionItems.views),
        sql`(${productionItems.platform}::jsonb @> '["YouTube Shorts"]'::jsonb OR ${productionItems.platform}::jsonb @> '["Instagram Reel"]'::jsonb OR ${productionItems.platform}::jsonb @> '["TikTok"]'::jsonb)`,
      ),
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(20);

  const derivatives: PerfRow[] = derivativeRows
    .filter((d) => isShortForm(d.platform as string[] | null))
    .map((d) => ({
      title: d.title,
      platform: d.platform as string[] | null,
      format: d.format,
      views: d.views,
      hook: d.hook,
    }));

  const { blueprint: blueprintRows, bench: benchRows } =
    await topShortFormPerformers({
      brand: item.brand,
      excludeDerivativesOfPillarId: pillarId,
      preferredFormat: PREFERRED_CLIP_FORMAT_FOR_BLUEPRINT,
    });
  const blueprint: BlueprintRow[] = blueprintRows.map((r) => ({
    title: r.title,
    platform: r.platform,
    format: r.format,
    views: r.views,
    hook: r.hook,
    overlay: r.overlay,
    contentBody: r.contentBody,
    coverDescription: r.coverDescription,
    likes: r.likes,
    comments: r.comments,
    publishedDate: r.publishedDate,
    openingTranscript: r.openingTranscript,
  }));
  const bench: PerfRow[] = benchRows.map((r) => ({
    title: r.title,
    platform: r.platform,
    format: r.format,
    views: r.views,
    hook: r.hook,
  }));

  const result = await generateClipIdeas({
    pillarTitle: item.title,
    pillarFormat: item.format,
    pillarChannels: item.platform,
    transcriptSegmentsMarkdown: transcript.segmentsMarkdown,
    transcriptWords: transcript.words,
    durationSec: transcript.durationSec,
    derivatives,
    blueprint,
    bench,
  });

  return {
    pillarId,
    pillarTitle: item.title,
    ideasReturned: result.ideas.length,
    diagnostics: result.diagnostics,
  };
}

function printPillar(r: PillarEvalResult) {
  console.log("");
  console.log("=".repeat(100));
  console.log(`PILLAR: ${r.pillarTitle ?? "(untitled)"} (${r.pillarId})`);
  console.log(
    `Ideas returned: ${r.ideasReturned} (out of ${r.diagnostics.length} proposed)`,
  );
  console.log("=".repeat(100));
  for (const d of r.diagnostics) {
    const status = !d.found
      ? "❌ NOT FOUND"
      : d.snapApplied
        ? `🔧 SNAPPED (${fmtTs(d.finalStartSec)}-${fmtTs(d.finalEndSec)})`
        : d.insideRange
          ? "✅ IN RANGE"
          : "❌ OUT OF RANGE";
    console.log("");
    console.log(`#${d.ideaIndex + 1}  ${status}`);
    console.log(`  hook:   ${d.hook}`);
    console.log(`  quote:  "${d.quote}"`);
    if (d.found && d.anchorStartSec != null) {
      console.log(`  anchor: ${fmtTs(d.anchorStartSec)}`);
    }
    console.log(
      `  range:  ${fmtTs(d.finalStartSec)}-${fmtTs(d.finalEndSec)} (${Math.round(d.finalEndSec - d.finalStartSec)}s)`,
    );
  }
}

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error(
      "Usage: tsx --env-file=.env.local scripts/eval-splice-v7.ts <pillarId> [<pillarId> ...]",
    );
    process.exit(1);
  }

  console.log(`Splice eval — PROMPT_VERSION=${PROMPT_VERSION} (${GENERATED_BY})`);
  console.log(`Pillars: ${ids.length}`);

  const results: PillarEvalResult[] = [];
  for (const id of ids) {
    try {
      const r = await evalPillar(id);
      if (r) {
        printPillar(r);
        results.push(r);
      }
    } catch (err) {
      console.error(`! pillar ${id} failed:`, err);
    }
  }

  // Aggregate.
  let totalProposed = 0;
  let totalShipped = 0;
  let totalFound = 0;
  let totalSnapped = 0;
  let totalInRange = 0;
  let totalNotFound = 0;
  let totalOutOfRange = 0;
  for (const r of results) {
    for (const d of r.diagnostics) {
      totalProposed++;
      if (!d.found) totalNotFound++;
      else if (d.insideRange) totalInRange++;
      else if (d.snapApplied) totalSnapped++;
      else totalOutOfRange++;
      if (d.found) totalFound++;
      if (d.found && (d.insideRange || d.snapApplied)) totalShipped++;
    }
  }

  console.log("");
  console.log("=".repeat(100));
  console.log("AGGREGATE");
  console.log("=".repeat(100));
  console.log(`Pillars evaluated:                         ${results.length}`);
  console.log(`Ideas proposed by LLM:                     ${totalProposed}`);
  console.log(`  ✅ anchor in original range:             ${totalInRange}`);
  console.log(`  🔧 anchor out-of-range, snapped:         ${totalSnapped}`);
  console.log(`  ❌ anchor out-of-range, unsnappable:     ${totalOutOfRange}`);
  console.log(`  ❌ anchor not found in transcript:       ${totalNotFound}`);
  console.log(`Ideas shipped (anchor inside final range): ${totalShipped}/${totalProposed}`);
  if (totalProposed > 0) {
    const pctShipped = ((totalShipped / totalProposed) * 100).toFixed(1);
    const pctNoSnap = ((totalInRange / totalProposed) * 100).toFixed(1);
    console.log(`  Ship rate:        ${pctShipped}%`);
    console.log(`  First-try rate:   ${pctNoSnap}% (in range without snapping)`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
