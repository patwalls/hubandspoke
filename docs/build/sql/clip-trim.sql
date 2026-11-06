-- clip-trim: do new clip ideas start where editors cut them?
-- Per writer version (generated_by) over 14 days: ideas written, how many the
-- writer narrowed inside their section (start later / end earlier by >= 3 s),
-- and how many were edited past the first draft. The head/tail cuts editors
-- make on those edits are computed in the app (src/lib/clip-editor/trim-habits.ts)
-- and shown per format on the format page; this is the writer-side half.
SELECT
  regexp_replace(ci.generated_by, '^.*(hook-v[0-9]+).*$', '\1') AS writer,
  count(*)                                                         AS ideas,
  count(*) FILTER (WHERE ci.start_sec - cs.start_sec >= 3)         AS narrowed_start,
  round(avg(ci.start_sec - cs.start_sec) FILTER (WHERE ci.start_sec - cs.start_sec >= 3), 1) AS avg_start_shift_s,
  count(*) FILTER (WHERE cs.end_sec - ci.end_sec >= 3)             AS narrowed_end,
  count(ce.id) FILTER (WHERE ce.revision > 1)                      AS edited
FROM clip_ideas ci
JOIN clip_sections cs ON cs.id = ci.clip_section_id
LEFT JOIN clip_edits ce ON ce.clip_idea_id = ci.id
WHERE ci.created_at > now() - interval '14 days'
GROUP BY 1
ORDER BY 1;
