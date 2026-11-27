-- Design exports: how often a design is exported again soon after, and how long
-- each export took (design-render; designs-right-first-export project).
WITH r AS (
  SELECT design_doc_id, created_at, render_seconds, status,
         lag(created_at) OVER (PARTITION BY design_doc_id ORDER BY created_at) AS prev_at,
         (doc::text LIKE '%"type": "video"%') AS has_video
  FROM design_renders
  WHERE created_at > now() - interval '30 days'
)
SELECT date_trunc('week', created_at)::date AS week,
       count(*) FILTER (WHERE prev_at IS NULL) AS first_exports,
       count(*) FILTER (WHERE prev_at IS NOT NULL AND created_at - prev_at < interval '30 min') AS quick_reexports,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY render_seconds) FILTER (WHERE has_video AND prev_at IS NULL AND status = 'done')::numeric, 1) AS video_first_p50_s,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY render_seconds) FILTER (WHERE has_video AND prev_at IS NOT NULL AND status = 'done')::numeric, 1) AS video_reexport_p50_s
FROM r GROUP BY 1 ORDER BY 1;
