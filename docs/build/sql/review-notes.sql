-- Review notes (project review-notes): do comments get pinned to a moment of the video?
-- Weekly: human comments, how many carry at_seconds, by how many people; plus the
-- comments:timecode / comments:seek marks. Team totals only.
SELECT date_trunc('week', c.created_at)::date AS week,
       count(*) AS comments,
       count(*) FILTER (WHERE c.at_seconds IS NOT NULL) AS pinned,
       count(DISTINCT c.user_id) FILTER (WHERE c.at_seconds IS NOT NULL) AS pinning_people,
       (SELECT count(*) FROM usage_events e
         WHERE e.screen = 'comments:seek'
           AND date_trunc('week', e.created_at) = date_trunc('week', c.created_at)) AS seeks
  FROM content_comments c
 WHERE c.user_id IS NOT NULL
   AND c.created_at > now() - interval '42 days'
 GROUP BY 1
 ORDER BY 1;
