# Hub & Spoke - Content Command Center

## Project Context
Standalone content reporting dashboard carved out from the Starter Story Rails app. Syncs content production data from Notion and displays analytics across platforms.

## Tech Stack
- Next.js 16 (App Router, TypeScript)
- Tailwind CSS + shadcn/ui
- Auth.js v5 (Credentials provider, JWT sessions, bcrypt)
- Heroku Postgres (PG 17)
- Drizzle ORM
- Postmark for transactional email
- Deployed on Heroku (auto-deploy on push to `main` via GitHub Actions)

## Development
- `npm run dev` - Start dev server (main worktree uses port 3000)
- `npm run build` - Production build
- `npx drizzle-kit generate` - Generate migrations
- `node --env-file=.env.local scripts/seed-user.mjs <email> <pass> [name]` - Seed a user

## Worktree Workflow
All feature work happens in a git worktree, not the main checkout. Set one up with:

```
./scripts/worktree-up.sh <branch-name> [port]
```

This creates `../hubandspoke-<branch-name>` off `origin/main`, symlinks `.env.local`
from the main checkout (secrets never get duplicated), runs `npm install`, and picks
the first free port ≥ 3001. It prints the exact `PORT=… npm run dev` command to run.

Notes:
- Turbopack rejects a symlinked `node_modules`, so each worktree needs a real install
  (~9s). Don't try to share `node_modules` via symlink.
- Delete the worktree after merge: `git worktree remove ../hubandspoke-<branch-name>`.

## Key Files
- `src/lib/db/schema.ts` - Database schema (Drizzle)
- `src/lib/services/notion-sync.ts` - Notion sync service
- `src/lib/db/queries.ts` - Report aggregation logic
- `src/components/dashboard/` - Dashboard UI components
- `src/lib/auth.ts` - Auth.js config
- `src/lib/email.ts` - Postmark client
- `src/lib/cron/jobs.ts` - Scheduled job registry (dispatched by `/api/cron/tick`)

## Cron / Scheduled Jobs
- One Heroku Scheduler entry hits `GET /api/cron/tick` every 10 minutes.
- The tick endpoint dispatches whichever entries in `src/lib/cron/jobs.ts` match the current 10-minute window.
- Add a job = add an entry to `CRON_JOBS` and deploy.

## Notion Integration
- Database ID: `8cb6cee4163d4282a5c87991ea689bde`
- Syncs content production items with metrics
- Format relation requires separate page fetch (cached)

## Critical Rules
- NEVER commit or push without explicit user permission
- NEVER expose API keys or secrets
