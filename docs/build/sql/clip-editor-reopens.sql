-- clip-editor-finishes: per person, clip-editor opens (21 d) and what followed each one within 2 h or until the next open:
-- a render by them, a saved edit, nothing; and how many no-render opens were followed by another open within 3 min.
-- Pair with the gap histogram: opens within 30 s of the previous one = reopens (accidental closes before M1).
WITH opens AS (
  SELECT u.user_id, u.created_at,
         lead(u.created_at) OVER (PARTITION BY u.user_id ORDER BY u.created_at) AS next_open
  FROM usage_events u
  WHERE u.screen = 'modal:clip-editor' AND u.created_at > now() - interval '21 days'
), o AS (
  SELECT o.*, (SELECT min(r.created_at) FROM clip_renders r WHERE r.requested_by_user_id = o.user_id
                 AND r.created_at >= o.created_at AND r.created_at < coalesce(least(o.next_open, o.created_at + interval '2 hours'), o.created_at + interval '2 hours')) AS rendered_at,
         (SELECT count(*) FROM clip_edits e WHERE e.created_by_user_id = o.user_id
                 AND e.updated_at >= o.created_at AND e.updated_at < coalesce(least(o.next_open, o.created_at + interval '2 hours'), o.created_at + interval '2 hours')) AS edits_touched
  FROM opens o
)
SELECT us.name,
  count(*) opens,
  count(rendered_at) opens_w_render,
  count(*) FILTER (WHERE rendered_at IS NULL AND edits_touched > 0) no_render_but_saved,
  count(*) FILTER (WHERE rendered_at IS NULL AND edits_touched = 0) no_render_no_save,
  count(*) FILTER (WHERE rendered_at IS NULL AND o.next_open - o.created_at < interval '3 minutes') no_render_reopen_3m,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.rendered_at - o.created_at)) med_s_to_render
FROM o JOIN users us ON us.id = o.user_id
GROUP BY us.name ORDER BY opens DESC;
