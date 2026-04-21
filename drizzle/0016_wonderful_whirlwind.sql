ALTER TABLE "production_items" DROP CONSTRAINT "production_items_producer_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "production_items" DROP CONSTRAINT "production_items_editor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "production_items" ALTER COLUMN "producer_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "production_items" ALTER COLUMN "editor_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_producer_user_id_users_id_fk" FOREIGN KEY ("producer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_editor_user_id_users_id_fk" FOREIGN KEY ("editor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;