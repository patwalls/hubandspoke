-- Where people hit walls (14 days): renders that failed or were retried, by person and error.
-- An error a person saw is a product bug, not only an ops one.
SELECT 'clip' AS kind, split_part(u.name, ' ', 1) AS who, r.status,
       left(coalesce(r.error, ''), 140) AS error, count(*) AS n, max(r.created_at)::date AS last
  FROM clip_renders r LEFT JOIN users u ON u.id = r.requested_by_user_id
 WHERE r.created_at > now() - interval '14 days' AND r.status NOT IN ('done', 'superseded')
 GROUP BY 1, 2, 3, 4
UNION ALL
SELECT 'design', split_part(u.name, ' ', 1), r.status,
       left(coalesce(r.error, ''), 140), count(*), max(r.created_at)::date
  FROM design_renders r LEFT JOIN users u ON u.id = r.requested_by_user_id
 WHERE r.created_at > now() - interval '14 days' AND r.status NOT IN ('done', 'superseded')
 GROUP BY 1, 2, 3, 4
 ORDER BY n DESC
 LIMIT 40;
