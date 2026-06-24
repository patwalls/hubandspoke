CREATE TABLE "brand_watermarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_watermarks" ADD CONSTRAINT "brand_watermarks_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_brand_watermarks_brand_id" ON "brand_watermarks" USING btree ("brand_id");