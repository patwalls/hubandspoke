-- User management & RBAC delta migration
-- Apply with: psql $DATABASE_URL -f scripts/migrate-user-management.sql
--
-- Safe to re-run: every statement uses IF NOT EXISTS / ON CONFLICT guards.

BEGIN;

-- 1. Extend users table with role + invitedBy
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'creator';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "invited_by" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_invited_by_users_id_fk'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_invited_by_users_id_fk"
      FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END$$;

-- 2. Invites table
CREATE TABLE IF NOT EXISTS "invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'creator',
  "invited_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_invites_email_lower"
  ON "invites" (lower("email"));

CREATE INDEX IF NOT EXISTS "idx_invites_status"
  ON "invites" ("accepted_at", "revoked_at", "expires_at");

-- 3. Bootstrap admins (no-op if the users don't exist yet; rerun safely)
UPDATE "users"
   SET "role" = 'admin'
 WHERE lower("email") IN ('patrickswalls@gmail.com', 'sam@starterstory.com');

COMMIT;
