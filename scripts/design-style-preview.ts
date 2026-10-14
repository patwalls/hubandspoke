/**
 * Dev tool: read a PUBLISHED post's cover into a cover style (the same Opus
 * extraction the `design-style-extract` job runs), then rasterize the
 * resulting template next to the original cover — for checking how close
 * the layout comes and tuning the prompt. Needs ANTHROPIC_API_KEY and the
 * S3 creds (pass them in-memory from `heroku config`).
 *
 *   npx tsx --env-file=.env.local scripts/design-style-preview.ts <publishedItemId> <outDir> [photo.jpg] [cutout.png] [--force]
 *
 * Writes <outDir>/original.<ext>, <outDir>/style.json and <outDir>/page-01.png
 * (via scripts/design-preview.ts, with the photo/cutout in the slots).
 */
import { execFileSync } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--force");
  const force = process.argv.includes("--force");
  const [itemId, outDir, photo, cutout] = args;
  if (!itemId || !outDir) throw new Error("usage: design-style-preview.ts <publishedItemId> <outDir> [photo.jpg] [cutout.png] [--force]");
  const { db } = await import("../src/lib/db");
  const { designCoverStyles } = await import("../src/lib/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { ensureCoverStyle, extractCoverStyle } = await import("../src/lib/services/design-editor/cover-styles");
  const { getPresignedGetUrl } = await import("../src/lib/s3");

  await mkdir(outDir, { recursive: true });
  // Create (or reset) the row, then extract in-process — no worker needed.
  // ensureCoverStyle enqueues a job too; without a local worker it just sits
  // and is removed below so a later worker never re-runs it.
  let state = await ensureCoverStyle(itemId);
  if (force && state.status !== "pending") {
    await db.update(designCoverStyles).set({ status: "pending", error: null, updatedAt: sql`now()` }).where(eq(designCoverStyles.id, state.id));
    state = { ...state, status: "pending" };
  }
  await db.execute(sql`SELECT graphile_worker.remove_job(${`design-style-extract:${state.id}`})`).catch(() => {});
  if (state.status === "pending") await extractCoverStyle(state.id, { log: (m) => console.log(m) });
  const [row] = await db.select().from(designCoverStyles).where(eq(designCoverStyles.id, state.id)).limit(1);
  if (!row || row.status !== "done" || !row.doc) throw new Error(`extraction ${row?.status ?? "missing"}: ${row?.error ?? ""}`);
  console.log(`summary: ${row.summary}`);

  const res = await fetch(await getPresignedGetUrl(row.mediaS3Key, 600, { bucket: row.mediaS3Bucket ?? undefined }));
  const ext = (res.headers.get("content-type") ?? "").includes("png") ? "png" : "jpg";
  await writeFile(path.join(outDir, `original.${ext}`), Buffer.from(await res.arrayBuffer()));
  const docPath = path.join(outDir, "style.json");
  await writeFile(docPath, JSON.stringify(row.doc, null, 2));
  for (const el of row.doc.pages[0].elements) console.log(`  ${el.type.padEnd(8)} ${el.name.padEnd(18)} ${el.x},${el.y} ${el.w}×${el.h}${el.slot ? ` slot=${el.slot.kind}` : ""}${el.rotation ? ` rot=${el.rotation}` : ""}${el.type === "text" ? ` ${el.style.fontId} ${el.style.sizePx}px "${el.spans.map((s) => s.text).join("").slice(0, 40)}"` : ""}`);
  execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/design-preview.ts", docPath, outDir, ...(photo ? [photo] : []), ...(cutout ? [cutout] : [])], { stdio: "inherit" });
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
