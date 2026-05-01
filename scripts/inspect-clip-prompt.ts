// One-off inspector: render the V6 system + user prompt for a given pillar
// without calling Sonnet. Lets you eyeball what the LLM sees.
//
// Usage: tsx --env-file=.env.local scripts/inspect-clip-prompt.ts <productionItemId>

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import { productionItems } from "../src/lib/db/schema";
import { getTranscriptForPrompt } from "../src/lib/services/whisper-transcribe";
import { topShortFormPerformers } from "../src/lib/db/queries";
import type {
  BlueprintRow,
  PerfRow,
} from "../src/lib/clip-idea-agent";

// Re-export a tiny shim to access the private buildReferenceLibrary +
// formatters. Easier path: re-import via the public API and just dump the
// inputs.
import {
  PROMPT_VERSION,
  GENERATED_BY,
} from "../src/lib/clip-idea-agent";

const PREFERRED_CLIP_FORMAT_FOR_BLUEPRINT = "Reel: Repackage Section w/ Hook";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: tsx scripts/inspect-clip-prompt.ts <productionItemId>");
    process.exit(1);
  }

  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      brand: productionItems.brand,
      format: productionItems.format,
      platform: productionItems.platform,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!item) {
    console.error(`No production_item with id ${id}`);
    process.exit(1);
  }

  const { blueprint: blueprintRows, bench: benchRows } =
    await topShortFormPerformers({
      brand: item.brand,
      excludeDerivativesOfPillarId: id,
      preferredFormat: PREFERRED_CLIP_FORMAT_FOR_BLUEPRINT,
    });

  console.log(`PROMPT_VERSION=${PROMPT_VERSION} GENERATED_BY=${GENERATED_BY}`);
  console.log(`Brand=${item.brand}, Pillar=${item.title}`);
  console.log(`Blueprint rows: ${blueprintRows.length}`);
  console.log(`Bench rows: ${benchRows.length}`);
  console.log("");

  console.log("=== BLUEPRINT (raw) ===");
  for (const r of blueprintRows.slice(0, 8)) {
    console.log(`hook=${JSON.stringify(r.hook)}`);
    console.log(`overlay=${JSON.stringify(r.overlay)}`);
    console.log(`views=${r.views}`);
    console.log("---");
  }

  console.log("");
  console.log("=== BENCH (raw) ===");
  for (const r of benchRows.slice(0, 5)) {
    console.log(`hook=${JSON.stringify(r.hook)} views=${r.views}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
