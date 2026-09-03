#!/usr/bin/env node
/**
 * One-shot backfill for the structured Descript layout-pack registry
 * (2026-09-03). Run AFTER migration 0102 is applied.
 *
 *   node --env-file=.env.local scripts/backfill-descript-layout-packs.mjs --dry-run
 *   heroku run --app=hubandspoke node scripts/backfill-descript-layout-packs.mjs --dry-run
 *
 * What it does:
 *   1. Registers the "Reels Layout" pack (verified template project in the
 *      HubSpot Descript account).
 *   2. Points the three starter-story clip formats at it via
 *      formats.descript_layout_pack_id.
 *   3. Cleans pack prose out of format Skills:
 *      - FK-set formats: the "Apply the layout pack …" sentence is removed
 *        entirely (the prompt builders now inject a canonical apply-by-id
 *        instruction from the registry).
 *      - other formats with pack prose: the line is annotated to say the
 *        link is not API-usable and the dropdown is the way forward. Their
 *        old references were already non-functional (regular project /
 *        wrong-account pack / unreachable library URL).
 */
import pg from "pg";

const DRY = process.argv.includes("--dry-run");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const ssl = process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false };
const pool = new pg.Pool({ connectionString: url, ssl });

const REELS_LAYOUT = {
  name: "Reels Layout",
  descriptId: "4ffdace6-835d-4ca1-a337-02e1a7e66b0a",
  pageUrl: "https://web.descript.com/4ffdace6-835d-4ca1-a337-02e1a7e66b0a/5d5a7",
  account: "hubspot",
};

// starter-story clip formats that use the Reels Layout pack.
const REELS_LAYOUT_FORMAT_IDS = [
  "68d6a688-a4c7-4a42-af5f-4dfc82ed677a", // starter-story / Repackage Section w/ Hook
  "7753c1ac-e283-450d-8bf0-3cbe3535dc1e", // starter-story / Reel: App Demo
  "099fe9f8-1162-4307-952a-17b208418610", // starter-story / Repackage Tech Stack With Hook
];

// The exact instruction this session previously wrote into the SS skill —
// removed verbatim (the registry-driven injection replaces it).
const SS_EXACT_SENTENCE =
  'Apply the layout pack named "Reels Layout" — its id is 4ffdace6-835d-4ca1-a337-02e1a7e66b0a (page: https://web.descript.com/4ffdace6-835d-4ca1-a337-02e1a7e66b0a/5d5a7). Your query_layout_packs tool may return an empty list — do NOT stop there; apply the pack directly by its id/URL with whatever layout tool accepts an identifier.';

// Matches the single-line legacy prose: "Apply the layout pack at https://web.descript.com/<id>[/<slug>]"
const LEGACY_PACK_LINE =
  /^Apply the layout pack (?:at )?https:\/\/web\.descript\.com\/\S+ ?/im;

// Replacements are phrased to flow into the text that follows the matched
// URL — typically "to this composition. The pack handles …".
const FK_SET_REPLACEMENT = "Apply the selected layout pack ";
const NO_FK_REPLACEMENT =
  "Apply the layout pack chosen in this format's settings (Descript layout pack dropdown — none selected yet; the link that used to be here was not usable by the Descript API) ";
const SS_SENTENCE_REPLACEMENT =
  "Apply the layout pack chosen in this format's settings (Descript layout pack dropdown).";

async function main() {
  const client = await pool.connect();
  try {
    // 1. Register the pack.
    const { rows: existing } = await client.query(
      "SELECT id FROM descript_layout_packs WHERE descript_id = $1",
      [REELS_LAYOUT.descriptId],
    );
    let packId = existing[0]?.id;
    if (!packId) {
      if (DRY) {
        console.log(`[dry-run] would insert pack "${REELS_LAYOUT.name}" (${REELS_LAYOUT.descriptId})`);
        packId = "(dry-run-pack-id)";
      } else {
        const { rows } = await client.query(
          `INSERT INTO descript_layout_packs (name, descript_id, page_url, descript_account)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [REELS_LAYOUT.name, REELS_LAYOUT.descriptId, REELS_LAYOUT.pageUrl, REELS_LAYOUT.account],
        );
        packId = rows[0].id;
        console.log(`inserted pack "${REELS_LAYOUT.name}" → ${packId}`);
      }
    } else {
      console.log(`pack already registered → ${packId}`);
    }

    // 2 + 3. Walk every format with pack prose or a pending FK.
    const { rows: formats } = await client.query(
      `SELECT id, brand, name, instructions, descript_layout_pack_id
       FROM formats
       WHERE instructions ILIKE '%apply the layout pack%'
          OR id = ANY($1)
       ORDER BY brand, name`,
      [REELS_LAYOUT_FORMAT_IDS],
    );

    for (const f of formats) {
      const wantsFk = REELS_LAYOUT_FORMAT_IDS.includes(f.id);
      let instructions = f.instructions ?? "";
      const before = instructions;

      if (instructions.includes(SS_EXACT_SENTENCE)) {
        instructions = instructions.replace(SS_EXACT_SENTENCE, SS_SENTENCE_REPLACEMENT);
      } else if (LEGACY_PACK_LINE.test(instructions)) {
        instructions = instructions.replace(
          LEGACY_PACK_LINE,
          wantsFk ? FK_SET_REPLACEMENT : NO_FK_REPLACEMENT,
        );
      }

      const changes = [];
      if (wantsFk && f.descript_layout_pack_id !== packId) changes.push("set FK → Reels Layout");
      if (instructions !== before) changes.push("clean Skill prose");
      if (changes.length === 0) {
        console.log(`= ${f.brand} / ${f.name}: no changes`);
        continue;
      }
      console.log(`${DRY ? "[dry-run] " : ""}${f.brand} / ${f.name}: ${changes.join(" + ")}`);
      if (instructions !== before) {
        const oldLine = (before.match(/^.*apply the layout pack.*$/im) ?? ["?"])[0];
        const newLine = (instructions.match(/^.*apply the layout pack.*$/im) ?? ["(removed)"])[0];
        console.log(`    - ${oldLine.slice(0, 160)}`);
        console.log(`    + ${newLine.slice(0, 160)}`);
      }
      if (!DRY) {
        await client.query(
          `UPDATE formats SET instructions = $1, descript_layout_pack_id = $2, updated_at = now() WHERE id = $3`,
          [instructions, wantsFk ? packId : f.descript_layout_pack_id, f.id],
        );
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
