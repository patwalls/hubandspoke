ALTER TABLE "formats" DROP CONSTRAINT "formats_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_formats_brand_name_lower" ON "formats" USING btree ("brand",lower("name"));--> statement-breakpoint
ALTER TABLE "formats" DROP COLUMN "content_owner_asana_gid";--> statement-breakpoint
ALTER TABLE "formats" DROP COLUMN "editor_asana_gid";--> statement-breakpoint
ALTER TABLE "formats" DROP COLUMN "producer_asana_gid";