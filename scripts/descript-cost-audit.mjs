// One-off: fetch media_seconds_used for every Descript job logged in
// repurpose_triggers over the last 24h. Throwaway — delete after use.
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const rows = await sql`
  SELECT
    rt.triggered_at,
    rt.descript_import_path AS path,
    rt.descript_job_id AS job_id,
    pillar.brand AS brand,
    substring(pillar.title, 1, 40) AS pillar_title
  FROM repurpose_triggers rt
  JOIN production_items pillar ON pillar.id = rt.production_item_id
  WHERE rt.triggered_at > '2026-05-18 00:00:00+00'
    AND rt.descript_job_id IS NOT NULL
  ORDER BY rt.triggered_at
`;

const totals = {};
for (const r of rows) {
  const res = await fetch(
    `https://descriptapi.com/v1/jobs/${r.job_id}`,
    { headers: { Authorization: `Bearer ${process.env.DESCRIPT_API_TOKEN}` } },
  );
  const j = await res.json();
  const secs =
    j.result?.media_seconds_used ??
    j.result?.media_status?.main?.duration_seconds ??
    null;
  const ts = r.triggered_at.toISOString().slice(0, 16).replace("T", " ");
  console.log(
    [
      ts,
      r.brand.padEnd(13),
      r.path.padEnd(18),
      "secs=" + (secs == null ? "null" : Math.round(secs)),
      r.pillar_title,
    ].join("  "),
  );
  if (secs != null) {
    totals[r.brand] = (totals[r.brand] || 0) + secs;
  }
}

console.log("\n--- totals (media_seconds_used) ---");
for (const [brand, secs] of Object.entries(totals)) {
  console.log(`${brand.padEnd(13)} ${Math.round(secs)} seconds`);
}

await sql.end();
