# Backlog

Ideas parked for later. Not a roadmap — a holding pen so they don't get
forgotten. When one gets picked up, either move it to `features.md` (as
**Planned**) or delete it.

---

## Investigate dedup collision in `account-content-sync`

**Why this is on its own:** the writer-policy fix landed 2026-04-25 stops
sync from clobbering `title` on every UPDATE, but the symptom that
prompted the bug — item `c4e0b823…` ("I Spent 24 Hours With A SaaS
Millionaire") showing the title "Jeremy Redman: Task Magic", and
`65f8105a…` ("My App Made $120K in 24 Hours") showing "Umberto Mezzadra:
Floga" — looks like more than field drift. Those are titles from
*completely different posts*, suggesting two distinct platform posts are
matching the same `production_items` row via dedup.

**Hypotheses to investigate, in order of likelihood:**
1. **Loose-URL fallback false positive.** `loadExisting` falls back to
   `looseUrlKey(publishedLink)` for legacy rows missing
   `platform_content_id`. If two unrelated posts on the same handle
   produce the same loose key (e.g. tracking-params stripped, both
   reduce to a domain-only URL), they'd collide.
2. **`extractContentId` returning the wrong id.** If the parser
   misreads a URL and returns a handle-level or account-level token
   instead of a per-post id, every post on that handle would dedup
   to the first row.
3. **Stale `platform_content_id` on a manually-imported row.** A
   manual "Add from link" row with a wrong-but-plausible id matches a
   different post's id on a sync sweep.

**How to investigate:**
- Pull the offending rows: `SELECT id, platform_content_id, published_link, title, created_at, updated_at FROM production_items WHERE id IN (...)` for `c4e0b823…` and `65f8105a…`.
- Check if `platform_content_id` matches the URL — if not, that's a
  smoking gun (hypothesis 2 or 3).
- Diff the loose URL keys for the two posts — if they match, that's
  hypothesis 1.

**Scope:** investigation + targeted fix to `loadExisting` /
`extractContentId` / `looseUrlKey` depending on root cause. May also
need a one-shot data-fix script for already-collided rows. Effort: low
once root cause is known; investigation is the unknown.

---

## Sync-layer integration test harness

**Why:** the writer-policy fix landed 2026-04-25 without tests. The
contract — UPDATE refreshes only engagement counters, INSERT writes the
full payload — is the kind of invariant a future contributor will
silently break by adding a field to the wrong payload.

**Shape of the tests:**
- Build on the existing pattern in
  `src/jobs/tasks/capture-velocity-snapshot.integration.test.ts` (real
  local Postgres, mocks for SC fetch and `enqueue`).
- New file: `src/lib/services/account-content-sync.integration.test.ts`.
- Test cases:
  1. INSERT path: a new `NormalizedItem` produces a row with all fields
     populated.
  2. UPDATE path — happy: a second sweep with refreshed views/likes
     updates *only* those columns; title/thumbnail/publishedAt unchanged.
  3. UPDATE path — null clobber regression: a sweep with `publishedAt:
     null` does *not* null out the existing column.
  4. UPDATE path — title drift regression: a sweep with a different
     title does not change the existing title.

**Effort:** ~2–3h. The harness already exists for velocity snapshots; this
is mostly fixture-building.

---

## Audit other writers of `production_items.published_at`

**Why:** the 2026-04-25 fix only addresses `account-content-sync`. The
PUT route at `src/app/api/production-items/route.ts`, the Notion sync,
and any manual-creation paths still need to be checked against the same
"trust + fallback" policy. If any of them null-clobber `published_at` on
edit, the velocity guard (added the same week) papers over it but the
underlying drift continues.

**Scope:** read each writer, decide per-column policy, fix any that
violate. Likely touches `src/app/api/production-items/route.ts`,
`src/lib/services/notion-sync.ts`. No schema change.
