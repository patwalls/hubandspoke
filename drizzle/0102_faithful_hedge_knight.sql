CREATE TABLE "descript_layout_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"descript_id" uuid NOT NULL,
	"page_url" text,
	"descript_account" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "descript_layout_packs_descript_id_unique" UNIQUE("descript_id")
);
--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "descript_layout_pack_id" uuid;--> statement-breakpoint
ALTER TABLE "formats" ADD CONSTRAINT "formats_descript_layout_pack_id_descript_layout_packs_id_fk" FOREIGN KEY ("descript_layout_pack_id") REFERENCES "public"."descript_layout_packs"("id") ON DELETE set null ON UPDATE no action;