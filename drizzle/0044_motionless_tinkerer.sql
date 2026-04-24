ALTER TABLE "transcripts" ALTER COLUMN "source" SET DEFAULT 'whisper';--> statement-breakpoint
ALTER TABLE "transcripts" ALTER COLUMN "raw_vtt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "words" jsonb;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "audio_s3_bucket" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "audio_s3_key" text;--> statement-breakpoint
ALTER TABLE "transcripts" DROP COLUMN "descript_published_slug";--> statement-breakpoint
ALTER TABLE "transcripts" DROP COLUMN "descript_share_url";--> statement-breakpoint
ALTER TABLE "transcripts" DROP COLUMN "descript_published_at";