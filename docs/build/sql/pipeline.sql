-- The content pipeline, week by week (8 weeks): what the team produces and where it sticks.
SELECT date_trunc('week', created_at)::date AS week,
       count(*) FILTER (WHERE event_type = 'item_created') AS items_created,
       count(*) FILTER (WHERE event_type = 'status_change') AS status_changes,
       count(*) FILTER (WHERE event_type = 'killed') AS killed,
       count(*) FILTER (WHERE event_type = 'cross_post_created') AS cross_posts,
       count(*) FILTER (WHERE event_type = 'tool_action' AND payload->>'tool' = 'clip-editor' AND payload->>'action' = 'clip_rendered') AS clips_rendered,
       count(*) FILTER (WHERE event_type = 'tool_action' AND payload->>'tool' = 'design-editor' AND payload->>'action' = 'design_rendered') AS designs_rendered,
       count(*) FILTER (WHERE event_type = 'tool_action' AND payload->>'tool' = 'descript') AS descript_actions,
       count(DISTINCT user_id) AS people
  FROM content_events
 WHERE created_at > now() - interval '8 weeks'
 GROUP BY 1
 ORDER BY 1 DESC;
