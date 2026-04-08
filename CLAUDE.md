# Hub & Spoke - Content Command Center

## Project Context
Standalone content reporting dashboard carved out from the Starter Story Rails app. Syncs content production data from Notion and displays analytics across platforms.

## Tech Stack
- Next.js 16 (App Router, TypeScript)
- Tailwind CSS + shadcn/ui
- Supabase (Auth + PostgreSQL)
- Drizzle ORM
- Deployed on Railway

## Development
- `npm run dev` - Start dev server
- `npm run build` - Production build
- `npx drizzle-kit push` - Push schema to database
- `npx drizzle-kit generate` - Generate migrations

## Key Files
- `src/lib/db/schema.ts` - Database schema (Drizzle)
- `src/lib/services/notion-sync.ts` - Notion sync service
- `src/lib/db/queries.ts` - Report aggregation logic
- `src/components/dashboard/` - Dashboard UI components

## Notion Integration
- Database ID: `8cb6cee4163d4282a5c87991ea689bde`
- Syncs content production items with metrics
- Format relation requires separate page fetch (cached)

## Critical Rules
- NEVER commit or push without explicit user permission
- NEVER expose API keys or secrets
