ALTER TABLE "brands" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;

-- Seed sort_order from the old BRAND_PRIORITY constants so existing order is preserved.
UPDATE brands SET sort_order = CASE slug
  WHEN 'starter-story'    THEN 0
  WHEN 'matg'             THEN 10
  WHEN 'my-first-million' THEN 20
  WHEN 'futurepedia'      THEN 30
  WHEN 'hubspot-marketing' THEN 40
  WHEN 'jonathan-hunt'    THEN 50
  ELSE 99
END;