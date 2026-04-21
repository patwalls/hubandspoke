-- Deduplicate existing utm_campaign values before enforcing uniqueness.
-- Keeps the earliest row's value intact; subsequent rows get a -N suffix so
-- the partial unique index below can be created without conflict.
WITH ranked AS (
  SELECT
    id,
    utm_campaign,
    row_number() OVER (
      PARTITION BY utm_campaign
      ORDER BY created_at, id
    ) AS rn
  FROM production_items
  WHERE utm_campaign IS NOT NULL
)
UPDATE production_items p
SET utm_campaign = ranked.utm_campaign || '-' || ranked.rn
FROM ranked
WHERE p.id = ranked.id AND ranked.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_production_items_utm_campaign" ON "production_items" USING btree ("utm_campaign") WHERE "production_items"."utm_campaign" IS NOT NULL;
