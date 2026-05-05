CREATE TABLE "descript_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "formats" ADD COLUMN "descript_pack_id" uuid;--> statement-breakpoint
ALTER TABLE "formats" ADD CONSTRAINT "formats_descript_pack_id_descript_packs_id_fk" FOREIGN KEY ("descript_pack_id") REFERENCES "public"."descript_packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Seed the Starter Story Reels pack with the prompt previously hardcoded in
-- src/lib/services/promote-clip-idea.ts and src/lib/descript.ts. Layout-pack
-- URL is the team's "Reels Layout" project in Descript (verified working
-- 2026-05-05). Existing "Reel: Repackage Section w/ Hook" format auto-attaches
-- so live Underlord runs keep working post-deploy with no UI work.
WITH new_pack AS (
  INSERT INTO "descript_packs" ("name", "prompt")
  VALUES (
    'Starter Story Reels',
    E'Apply the layout pack at https://web.descript.com/1cf77b5b-68e6-4c71-bb4a-edf7f1f17044 to this composition. The pack handles vertical 9:16 framing, the hook-text track, and the captions slot — use it instead of manually setting aspect ratio or adding caption tracks.\n\nSet the hook text track at the top of the composition to: "{{hook}}". Replace whatever placeholder or default text the layout pack provides — do not append; replace.\n\nInside the composition, mark filler words ("um", "uh", "like" when used as filler, "you know", "I mean", false starts, repeated words, and long silences > 400ms) as IGNORED — use Descript''s ignore / strike-through feature so the words remain visible in the script crossed out but are skipped during playback. DO NOT DELETE these words.\n\nDo not add transitions, effects, music, or title cards beyond what the layout pack already includes. Do not re-order anything. Do not rewrite the transcript.'
  )
  RETURNING id
)
UPDATE "formats"
SET descript_pack_id = (SELECT id FROM new_pack), updated_at = now()
WHERE id = '68d6a688-a4c7-4a42-af5f-4dfc82ed677a';