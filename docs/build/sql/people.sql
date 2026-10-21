-- Who uses Hub & Spoke and how (the /build loop's first read). One row per person active in 30 days.
-- `hk psql hubandspoke -f docs/build/sql/people.sql`. Names only: loop_ro cannot read emails.
SELECT u.name,
       u.role || coalesce('/' || u.content_role, '') AS role,
       count(e.*) AS actions_30d,
       count(DISTINCT date(e.created_at)) AS active_days_30d,
       max(e.created_at)::date AS last_action,
       (SELECT string_agg(t.event_type || ' ' || t.n, ', ' ORDER BY t.n DESC)
          FROM (SELECT event_type, count(*) n FROM content_events
                 WHERE user_id = u.id AND created_at > now() - interval '30 days'
                 GROUP BY 1 ORDER BY 2 DESC LIMIT 4) t) AS top_actions,
       (SELECT count(*) FROM usage_events v WHERE v.user_id = u.id AND v.created_at > now() - interval '14 days') AS views_14d,
       (SELECT string_agg(s.screen || ' ' || s.n, ', ' ORDER BY s.n DESC)
          FROM (SELECT screen, count(*) n FROM usage_events
                 WHERE user_id = u.id AND created_at > now() - interval '14 days'
                 GROUP BY 1 ORDER BY 2 DESC LIMIT 5) s) AS top_screens_14d
  FROM users u
  LEFT JOIN content_events e ON e.user_id = u.id AND e.created_at > now() - interval '30 days'
 GROUP BY u.id, u.name, u.role, u.content_role
HAVING count(e.*) > 0
    OR EXISTS (SELECT 1 FROM usage_events v WHERE v.user_id = u.id AND v.created_at > now() - interval '30 days')
 ORDER BY actions_30d DESC;
