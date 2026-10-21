-- What gets opened (usage_events, recorded since 2026-10-21): every screen and mark in 14 days,
-- how often, by how many people, by whom. A route missing here was not opened at all.
SELECT v.kind, v.screen,
       count(*) AS opens_14d,
       count(*) FILTER (WHERE v.created_at > now() - interval '2 days') AS opens_2d,
       count(DISTINCT v.user_id) AS people,
       string_agg(DISTINCT split_part(u.name, ' ', 1), ', ') AS who,
       max(v.created_at)::date AS last
  FROM usage_events v
  LEFT JOIN users u ON u.id = v.user_id
 WHERE v.created_at > now() - interval '14 days'
 GROUP BY 1, 2
 ORDER BY opens_14d DESC
 LIMIT 120;
