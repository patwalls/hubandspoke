/**
 * Backfill: put punctuation back on every Whisper transcript's words.
 *
 * Whisper's word timestamps come without punctuation; the segments have it.
 * From 2026-09-20 the pipeline aligns the two at save time
 * (src/lib/transcripts/punctuate-words.ts). This does the same for rows
 * transcribed before then — pure string alignment, no API calls, timing
 * untouched. Idempotent: rows whose words already carry punctuation skip.
 *
 *   heroku run --app hubandspoke -- npx tsx scripts/backfill-punctuate-words.ts
 *   heroku run --app hubandspoke -- npx tsx scripts/backfill-punctuate-words.ts --apply
 */
import postgres from "postgres";
import { needsPunctuation, punctuateWords } from "../src/lib/transcripts/punctuate-words";

const apply = process.argv.includes("--apply");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const sql = postgres(databaseUrl, { ssl: databaseUrl.includes("localhost") ? false : "require", max: 2 });

async function main() {
  const rows = await sql`SELECT id, production_item_id, words, segments FROM transcripts WHERE words IS NOT NULL AND jsonb_array_length(words) > 0 AND source LIKE 'whisper%'`;
  let todo = 0;
  let done = 0;
  for (const r of rows) {
    if (!needsPunctuation(r.words, r.segments ?? [])) continue;
    todo++;
    if (!apply) continue;
    const words = punctuateWords(r.words, r.segments ?? []);
    await sql`UPDATE transcripts SET words = ${sql.json(words)} WHERE id = ${r.id}`;
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${todo}…`);
  }
  console.log(`${rows.length} whisper transcripts, ${todo} need punctuation${apply ? `, ${done} updated` : " (dry run — add --apply)"}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
