release: npm run db:migrate && npm run worker:migrate && node scripts/backfill-accounts.mjs --apply-if-pending && node scripts/backfill-clip-ideas-target-format.mjs --apply-if-pending && node scripts/seed-x-quotables-format.mjs --apply-if-pending
web: bash scripts/boot-web.sh
worker: npm run worker
