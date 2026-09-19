ALTER TABLE "design_frames" ADD COLUMN "rank" integer;--> statement-breakpoint
-- design_frames are now keyed by the SOURCE video (the pillar), so every post
-- made from it shares the library. Remap rows made under a derivative; where
-- two derivatives had grabbed the same second, keep the newest done row.
DELETE FROM "design_frames" f USING "design_frames" g, "production_items" p, "production_items" q
 WHERE f.production_item_id = p.id AND g.production_item_id = q.id AND f.id <> g.id
   AND COALESCE(p.pillar_content_item_id, p.id) = COALESCE(q.pillar_content_item_id, q.id)
   AND f.sec = g.sec
   AND (f.status <> 'done' AND g.status = 'done' OR (f.status = g.status AND f.created_at < g.created_at));--> statement-breakpoint
UPDATE "design_frames" f SET production_item_id = p.pillar_content_item_id, is_pick = false
  FROM "production_items" p
 WHERE f.production_item_id = p.id AND p.pillar_content_item_id IS NOT NULL;--> statement-breakpoint
UPDATE "design_frames" SET rank = 1 WHERE is_pick;
