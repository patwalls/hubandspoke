-- Clip odds check (2026-11-07): does anything about a clip idea itself tell
-- apart, WITHIN one video, the published idea clips that beat their format's
-- usual? lift = ln(views / median of the same brand + format + platform in
-- the 90 days before). w_* = correlations after removing each video's mean.
-- 2026-11-07: n=315, 83 videos — w_est -0.06, w_len -0.08, w_pos -0.17,
-- w_hs 0.03, w_hooklen 0.09. None beat the format's record on the account,
-- so that is what orders a video's ideas (src/lib/clip-odds.ts). Re-run
-- before ordering ideas by anything else.
WITH x AS (
  SELECT pi.id, ci.source_production_item_id src, ci.target_format tf, ci.estimated_views est, pi.views v, pi.format, pi.platform, pi.brand, pi.published_date,
         (ci.end_sec - ci.start_sec)::float len, ci.start_sec::float st, coalesce(jsonb_array_length(ci.hook_segments),0) hs, length(ci.hook) hooklen, ci.generated_by
  FROM clip_ideas ci JOIN production_items pi ON pi.id = ci.accepted_production_item_id
  WHERE pi.views IS NOT NULL AND pi.published_date IS NOT NULL
), b AS (
  SELECT x.*, (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY h.views) FROM production_items h
     WHERE h.brand=x.brand AND h.format=x.format AND h.platform=x.platform AND h.views IS NOT NULL
       AND h.published_date < x.published_date AND h.published_date > x.published_date-90) hist,
     (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY h.views) FROM production_items h
     WHERE h.brand=x.brand AND h.platform=x.platform AND h.views IS NOT NULL
       AND h.published_date < x.published_date AND h.published_date > x.published_date-90) acct
  FROM x
)

, c AS (SELECT b.*, ln((v+1)/(hist+1.0)) lift, ln(est+1.0) lest, ln(len+1) llen,
   st/nullif((SELECT max(end_sec)::float FROM clip_ideas z WHERE z.source_production_item_id=b.src),0) pos
  FROM b WHERE hist IS NOT NULL),
d AS (SELECT c.*, lift-avg(lift) OVER (PARTITION BY src) wl, lest-avg(lest) OVER (PARTITION BY src) wlest,
   llen-avg(llen) OVER (PARTITION BY src) wllen, pos-avg(pos) OVER (PARTITION BY src) wpos, hs-avg(hs) OVER (PARTITION BY src) whs,
   hooklen-avg(hooklen) OVER (PARTITION BY src) whl, count(*) OVER (PARTITION BY src) nsrc FROM c)
SELECT count(*) n, count(DISTINCT src) srcs,
 round(corr(lift,lest)::numeric,2) est, round(corr(lift,llen)::numeric,2) len, round(corr(lift,pos)::numeric,2) pos,
 round(corr(lift,hs)::numeric,2) hs, round(corr(lift,hooklen)::numeric,2) hooklen,
 round(corr(wl,wlest) FILTER (WHERE nsrc>1)::numeric,2) w_est, round(corr(wl,wllen) FILTER (WHERE nsrc>1)::numeric,2) w_len,
 round(corr(wl,wpos) FILTER (WHERE nsrc>1)::numeric,2) w_pos, round(corr(wl,whs) FILTER (WHERE nsrc>1)::numeric,2) w_hs,
 round(corr(wl,whl) FILTER (WHERE nsrc>1)::numeric,2) w_hooklen, count(*) FILTER (WHERE nsrc>1) n_multi
FROM d;
