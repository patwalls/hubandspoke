-- Clip stitching: on clips editors changed by hand (clip_edits revision > 1,
-- last 60 days), how many pull in a body moment from OUTSIDE the AI's
-- [start_sec, end_sec] window, by brand + target format. Also counts how many
-- of those clips had stitch suggestions from the section picker
-- (clip_sections.supporting_moments, 2026-11-05+).
WITH body AS (
  SELECT ce.clip_idea_id, ce.revision,
         (s->>'startSec')::numeric AS s_start, (s->>'endSec')::numeric AS s_end
  FROM clip_edits ce, jsonb_array_elements(ce.doc->'sections') s
  WHERE ce.revision > 1
    AND ce.updated_at > now() - interval '60 days'
    AND coalesce(s->>'role', 'body') = 'body'
    AND s->>'mediaId' IS NULL
),
per_clip AS (
  SELECT b.clip_idea_id, max(b.revision) AS revision,
         count(*) FILTER (WHERE b.s_end <= ci.start_sec::numeric - 1
                             OR b.s_start >= ci.end_sec::numeric + 1) AS outside
  FROM body b JOIN clip_ideas ci ON ci.id = b.clip_idea_id
  GROUP BY 1
)
SELECT br.slug AS brand,
       ci.target_format AS format,
       count(*) AS edited_clips,
       count(*) FILTER (WHERE pc.outside > 0) AS stitched_clips,
       round(avg(pc.outside) FILTER (WHERE pc.outside > 0), 1) AS moments_per_stitched,
       round(avg(pc.revision) FILTER (WHERE pc.outside > 0)) AS avg_rev_stitched,
       round(avg(pc.revision) FILTER (WHERE pc.outside = 0)) AS avg_rev_plain,
       count(*) FILTER (WHERE jsonb_array_length(coalesce(cs.supporting_moments, '[]'::jsonb)) > 0) AS had_suggestions
FROM per_clip pc
JOIN clip_ideas ci ON ci.id = pc.clip_idea_id
LEFT JOIN clip_sections cs ON cs.id = ci.clip_section_id
LEFT JOIN production_items pi ON pi.id = ci.source_production_item_id
LEFT JOIN accounts a ON a.id = pi.account_id
LEFT JOIN brands br ON br.id = a.brand_id
GROUP BY 1, 2
ORDER BY edited_clips DESC;
