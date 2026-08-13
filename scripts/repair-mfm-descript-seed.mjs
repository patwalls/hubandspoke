/**
 * One-shot repair: fix the corrupted descript_seed_composition_id on pillar
 * a3080d43-7165-4e1f-adbf-c3e2d0d68a63 ("2 drunk multi-millionaires…").
 *
 * The pillar's current seed (bd1e9d68) is a 44.74s derivative clip, not the
 * full-length source. This script:
 *   1. Tries to discover the correct full-length composition in project
 *      3b8ed8e9 via the Descript API.
 *   2. If found, stamps it as descript_seed_composition_id and exits.
 *   3. If not found, re-imports the pillar's S3 media into Descript to create
 *      a clean full-length seed, then stamps it.
 *
 * Run on Heroku (where tokens + DB are live):
 *   heroku run --app hubandspoke node scripts/repair-mfm-descript-seed.mjs
 *
 * Safe to re-run: the DB UPDATE is idempotent. A second import would create a
 * duplicate composition but the script checks for the existing seed first.
 */

import pg from "pg";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const PILLAR_ID   = "a3080d43-7165-4e1f-adbf-c3e2d0d68a63";
const PROJECT_ID  = "3b8ed8e9-7976-4e03-ad30-c59d67a3bdc5";
const BAD_SEED    = "bd1e9d68-a457-4c20-aa58-add3770fb4fa";
const S3_KEY      = "hubandspoke/uploads/a3080d43-7165-4e1f-adbf-c3e2d0d68a63/957f7a46-a2e6-46b4-add7-c8983351c09a-ejji5olw-r4.mp4";
const PILLAR_NAME = "2 drunk multi-millionaires brainstorm 9 business ideas";
const BASE        = "https://descriptapi.com/v1";

const token = process.env.DESCRIPT_API_TOKEN_HUBSPOT;
if (!token) { console.error("DESCRIPT_API_TOKEN_HUBSPOT not set"); process.exit(1); }

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

// ── Phase 1: probe for existing full-length composition ──────────────────────

let seedCompositionId = null;

console.log("Phase 1: probing Descript API for existing compositions in project", PROJECT_ID);

// Try GET /compositions?project_id=... — endpoint may not exist (404)
const r1 = await fetch(`${BASE}/compositions?project_id=${PROJECT_ID}`, { headers: h });
const d1 = await r1.json();
console.log(`  GET /compositions?project_id=... → ${r1.status}`, JSON.stringify(d1).slice(0, 400));

if (r1.ok && Array.isArray(d1.compositions)) {
  // Filter out the known bad derivative UUIDs; pick any remaining
  const candidates = d1.compositions.filter(c => c.id !== BAD_SEED);
  console.log("  Composition candidates:", candidates.map(c => `${c.id} "${c.name}"`));
  // Prefer the one named after the pillar (the original import name)
  const fullLen = candidates.find(c =>
    c.name?.toLowerCase().includes("drunk") ||
    c.name?.toLowerCase().includes("millionaire") ||
    c.name === PILLAR_NAME,
  ) ?? candidates[0];
  if (fullLen) {
    console.log(`  Found candidate: ${fullLen.id} "${fullLen.name}"`);
    seedCompositionId = fullLen.id;
  }
}

// ── Phase 2: if not found, re-import from S3 ────────────────────────────────

if (!seedCompositionId) {
  console.log("\nPhase 2: no full-length composition found via API — re-importing from S3");

  const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  const presigned = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET ?? "hubandspoke",
      Key: S3_KEY,
    }),
    { expiresIn: 3600 },
  );
  console.log("  S3 presigned URL generated");

  // Try importing into the EXISTING project (project_id instead of project_name).
  // If Descript rejects project_id, it will either error or create a new project.
  const importBody = {
    project_id: PROJECT_ID,
    add_media: { main: { url: presigned } },
    add_compositions: [{ name: `${PILLAR_NAME} (seed)`, clips: [{ media: "main" }] }],
  };

  const ir = await fetch(`${BASE}/jobs/import/project_media`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(importBody),
  });
  const importData = await ir.json();
  console.log("  Import response:", JSON.stringify(importData).slice(0, 400));

  if (!importData.job_id) {
    // project_id not accepted — fall back to new-project import
    console.log("  project_id not accepted; falling back to new project import");
    const fbBody = {
      project_name: `${PILLAR_NAME} (seed repair ${Date.now()})`,
      add_media: { main: { url: presigned } },
      add_compositions: [{ name: `${PILLAR_NAME} (seed)`, clips: [{ media: "main" }] }],
    };
    const fbr = await fetch(`${BASE}/jobs/import/project_media`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(fbBody),
    });
    const fbData = await fbr.json();
    console.log("  Fallback import response:", JSON.stringify(fbData).slice(0, 400));
    if (!fbData.job_id) {
      console.error("  Both import attempts failed — aborting");
      await pool.end();
      process.exit(1);
    }
    importData.job_id = fbData.job_id;
    importData.project_id = fbData.project_id;
    importData.project_url = fbData.project_url;
  }

  const jobId = importData.job_id;
  const newProjectId = importData.project_id ?? PROJECT_ID;
  console.log(`  Import job started: ${jobId}, project: ${newProjectId}`);

  // Poll until done
  console.log("  Polling (up to 10 min)…");
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const pr = await fetch(`${BASE}/jobs/${jobId}`, { headers: h });
    const job = await pr.json();
    process.stdout.write(`  poll ${i + 1}/60 state=${job.job_state}\r`);
    if (job.job_state === "stopped") {
      process.stdout.write("\n");
      if (job.result?.status === "error") {
        console.error("  Import job failed:", job.result.error_message);
        await pool.end();
        process.exit(1);
      }
      seedCompositionId = job.result?.created_compositions?.[0]?.id ?? null;
      console.log("  created_compositions:", JSON.stringify(job.result?.created_compositions));

      // If a new project was created, update the pillar + derivatives
      if (newProjectId !== PROJECT_ID) {
        console.log(`  New project created: ${newProjectId} — updating pillar + derivatives`);
        await pool.query(
          `UPDATE production_items
             SET descript_project_id   = $1,
                 descript_project_url  = $2,
                 updated_at            = now()
           WHERE id = $3`,
          [newProjectId, `https://web.descript.com/${newProjectId}`, PILLAR_ID],
        );
        await pool.query(
          `UPDATE production_items
             SET descript_project_id   = $1,
                 descript_project_url  = $2,
                 updated_at            = now()
           WHERE pillar_content_item_id = $3
             AND descript_project_id    = $4`,
          [newProjectId, `https://web.descript.com/${newProjectId}`, PILLAR_ID, PROJECT_ID],
        );
      }
      break;
    }
  }
}

// ── Phase 3: stamp the seed ──────────────────────────────────────────────────

if (!seedCompositionId) {
  console.error("\nFailed to identify or create a full-length composition. Aborting without DB write.");
  await pool.end();
  process.exit(1);
}

console.log(`\nPhase 3: stamping seed=${seedCompositionId} on pillar ${PILLAR_ID}`);
const { rows } = await pool.query(
  `UPDATE production_items
     SET descript_seed_composition_id = $1, updated_at = now()
   WHERE id = $2
   RETURNING descript_seed_composition_id`,
  [seedCompositionId, PILLAR_ID],
);
console.log("Updated:", rows[0]);

await pool.end();
console.log("\nDone. Verify with:");
console.log(`  heroku pg:psql --app hubandspoke -c "SELECT descript_seed_composition_id FROM production_items WHERE id = '${PILLAR_ID}'"`);
