CREATE TABLE "brand_logos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" text NOT NULL,
	"label" text NOT NULL,
	"s3_bucket" text NOT NULL,
	"s3_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_logos" ADD CONSTRAINT "brand_logos_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_logos_brand_idx" ON "brand_logos" USING btree ("brand");