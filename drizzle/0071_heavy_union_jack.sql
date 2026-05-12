CREATE TABLE "canva_oauth" (
	"id" text PRIMARY KEY NOT NULL,
	"refresh_token" text NOT NULL,
	"access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
