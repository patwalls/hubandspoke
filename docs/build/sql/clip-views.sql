-- Est. Views honesty check for clips that came from a clip idea and published:
-- the clip writer's own guess (clip_ideas.estimated_views) vs a plain history
-- baseline (median views of the same brand + format + platform over the 90 days
-- before the clip published), each scored by the median |ln(guess / actual)|
-- (0.69 = 2× off, 2.3 = 10× off) and the share that ran more than 3× high.
-- The queue shows the history-based predictor (production-report.ts); re-run
-- this before letting any other number win there.
WITH x AS (
  SELECT pi.id, ci.estimated_views est, pi.views v, pi.format, pi.platform, pi.brand, pi.published_date
  FROM clip_ideas ci JOIN production_items pi ON pi.id = ci.accepted_production_item_id
  WHERE ci.estimated_views IS NOT NULL AND pi.views IS NOT NULL AND pi.published_date IS NOT NULL
), b AS (
  SELECT x.*, (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY h.views)
               FROM production_items h
               WHERE h.brand = x.brand AND h.format = x.format AND h.platform = x.platform
                 AND h.views IS NOT NULL AND h.published_date < x.published_date
                 AND h.published_date > x.published_date - 90) hist
  FROM x
)
SELECT count(*) n, count(hist) with_hist,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(ln((est+1)/(v+1.0))))::numeric,2) llm_med_abs_log_err,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(ln((hist+1)/(v+1.0)))) FILTER (WHERE hist IS NOT NULL))::numeric,2) hist_med_abs_log_err,
  round(avg(CASE WHEN est > 3*v THEN 1 ELSE 0 END)::numeric,2) llm_over3x,
  round(avg(CASE WHEN hist > 3*v THEN 1 ELSE 0 END) FILTER (WHERE hist IS NOT NULL)::numeric,2) hist_over3x
FROM b;
