/**
 * Dev tool: run speaker detection for ONE item in-process, without a graphile
 * worker — drives the `diarize-transcript` task through its kickoff + every
 * chunk invocation by feeding each re-enqueued payload straight back in.
 *
 *   npx tsx --env-file=.env.local scripts/diarize-run.ts <productionItemId> [--force]
 *
 * (Never `npm run worker` against a /pulldb'd DB — it would run every queued
 * prod job.) Needs OPENAI_API_KEY, ANTHROPIC_API_KEY and S3 credentials.
 */
import type { JobHelpers } from "graphile-worker";

async function main() {
  const productionItemId = process.argv[2];
  if (!productionItemId) throw new Error("usage: diarize-run.ts <productionItemId> [--force]");
  const { diarizeTranscriptTask } = await import("../src/jobs/tasks/diarize-transcript");
  const { db } = await import("../src/lib/db");
  const { transcripts } = await import("../src/lib/db/schema");
  const { eq } = await import("drizzle-orm");

  let next: Record<string, unknown> | null = {
    productionItemId,
    force: process.argv.includes("--force"),
  };
  while (next) {
    const payload = next;
    next = null;
    const helpers = {
      logger: {
        info: (m: string) => console.log("[info]", m),
        warn: (m: string) => console.warn("[warn]", m),
        error: (m: string) => console.error("[error]", m),
        debug: () => {},
      },
      job: { attempts: 1, max_attempts: 1 },
      addJob: async (_name: string, p: Record<string, unknown>) => {
        next = p;
      },
    };
    await diarizeTranscriptTask(payload, helpers as unknown as JobHelpers);
  }

  const [t] = await db
    .select({ speakers: transcripts.speakers, segments: transcripts.segments, state: transcripts.diarization })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, productionItemId))
    .limit(1);
  console.log("\nspeakers:", JSON.stringify(t?.speakers, null, 1));
  console.log("\nfirst turns:");
  for (const s of (t?.segments ?? []).slice(0, 14)) {
    console.log(`  [${String(s.speaker ?? "—").padEnd(12)}] ${s.text.slice(0, 90)}`);
  }
  console.log("\nusage:", t?.state?.usage, "status:", t?.state?.status);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
