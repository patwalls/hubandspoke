-- Review notes (project review-notes): do comments get pinned to a moment of the video?
-- Weekly: human comments, how many carry at_seconds, by how many people; plus the
-- comments:seek marks (chip clicks). Team totals only.
WITH c AS (
  SELECT date_trunc('week', created_at)::date AS week,
         count(*) AS comments,
         count(*) FILTER (WHERE at_seconds IS NOT NULL) AS pinned,
         count(DISTINCT user_id) FILTER (WHERE at_seconds IS NOT NULL) AS pinning_people
    FROM content_comments
   WHERE user_id IS NOT NULL AND created_at > now() - interval '42 days'
   GROUP BY 1
), s AS (
  SELECT date_trunc('week', created_at)::date AS week, count(*) AS seeks
    FROM usage_events
   WHERE screen = 'comments:seek' AND created_at > now() - interval '42 days'
   GROUP BY 1
)
SELECT c.*, coalesce(s.seeks, 0) AS seeks
  FROM c LEFT JOIN s USING (week)
 ORDER BY week;
