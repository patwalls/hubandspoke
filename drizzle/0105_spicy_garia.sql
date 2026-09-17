ALTER TABLE "transcripts" ADD COLUMN "speakers" jsonb;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "diarization" jsonb;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "diarized_at" timestamp with time zone;