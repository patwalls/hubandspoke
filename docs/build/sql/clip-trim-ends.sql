-- clip-trim-ends: what editors cut off each end of the AI clip window, per
-- writer version (generated_by), over edited clips (revision > 1) of the last
-- 45 days. SQL approximation of clipTrim (src/lib/clip-editor/trim-habits.ts):
-- the source scene overlapping the window most, a removal touching its start
-- (or end) is the head (tail) cut. clip-trim M3 (hook-v7) aims the tail share
-- down from ~60% on hook-v5/v6.
WITH e AS (
  SELECT ci.id, regexp_replace(ci.generated_by, '^.*(hook-v[0-9]+).*$', '\1') AS w,
         ci.start_sec::float s0, ci.end_sec::float e0, ce.doc
  FROM clip_ideas ci JOIN clip_edits ce ON ce.clip_idea_id = ci.id
  WHERE ce.revision > 1 AND ci.created_at > now() - interval '45 days'
), sec AS (
  SELECT e.id, e.w, e.s0, e.e0, x AS sx,
    greatest(0, least((x->>'endSec')::float, e.e0) - greatest((x->>'startSec')::float, e.s0)) ov,
    row_number() OVER (PARTITION BY e.id ORDER BY greatest(0, least((x->>'endSec')::float, e.e0) - greatest((x->>'startSec')::float, e.s0)) DESC) rn
  FROM e, jsonb_array_elements(e.doc->'sections') x
  WHERE x->>'mediaId' IS NULL
), m AS (
  SELECT id, w, s0, e0, sx,
    greatest((sx->>'startSec')::float, coalesce((SELECT max((r->>'endSec')::float) FROM jsonb_array_elements(sx->'removals') r WHERE (r->>'startSec')::float <= (sx->>'startSec')::float + 0.5), 0)) - s0 AS head,
    e0 - least((sx->>'endSec')::float, coalesce((SELECT min((r->>'startSec')::float) FROM jsonb_array_elements(sx->'removals') r WHERE (r->>'endSec')::float >= (sx->>'endSec')::float - 0.5), 1e9)) AS tail
  FROM sec WHERE rn = 1 AND ov > 0
)
SELECT w AS writer, count(*) AS clips,
  count(*) FILTER (WHERE head >= 3) AS head_cut,
  round(100.0 * count(*) FILTER (WHERE head >= 3) / count(*)) AS head_pct,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY head) FILTER (WHERE head >= 3)::numeric, 1) AS med_head_s,
  count(*) FILTER (WHERE tail >= 3) AS tail_cut,
  round(100.0 * count(*) FILTER (WHERE tail >= 3) / count(*)) AS tail_pct,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY tail) FILTER (WHERE tail >= 3)::numeric, 1) AS med_tail_s
FROM m GROUP BY 1 ORDER BY 1;
