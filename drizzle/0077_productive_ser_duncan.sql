CREATE TABLE "worker_heartbeat" (
	"id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"worker_dyno" text
);
