# Post Classification

Canonical definitions for the `productionItems.sourceType` column. Read this
before adding any new write site, classifier, or report that branches on
source type. Cross-references: schema in `src/lib/db/schema.ts:213-234`,
display in `src/components/ui/source-badge.tsx`, write sites listed at the
bottom of this doc.

---

## The four values

| Value | Meaning |
|---|---|
| `original` | The first time this content was posted on this platform. Default. |
| `repost` | Same content, **same platform**, posted again — same account *or* a different one. |
| `cross_post` | Same content, **different platform** from the original. |
| `repurposed` | Derivative of a pillar — different content, same source. Covers both `threshold-monitor-sweep` auto-spawns and rows promoted from clip ideas. |

The five-value form (with a separate `clip` value) was collapsed into this
four-value form on 2026-05-11. Rows that used to be `sourceType='clip'`
became `sourceType='repurposed'` while keeping their `sourceClipIdeaId`
FK — the clip-triage modal and the Descript pipeline both key off the FK,
not the source-type string. See
`scripts/migrate-source-type-consolidation.mjs` for the one-shot backfill.

---

## The decision rule

Given a post that is going into the system:

1. **Is the content essentially the same as an earlier post?** (See "What 'same content' means" below.)
   - **No** → `original`. Stop.
   - **Yes** → continue to step 2.
2. **Is it on the same platform as that earlier post?**
   - **Yes** → `repost`. Set `repostedFromItemId` to the earliest occurrence.
   - **No** → `cross_post`. Set `repostedFromItemId` to the earliest occurrence.

Notes:

- **Account doesn't matter for the repost/cross-post split.** A re-run of a
  @thepatwalls X tweet on @starter_story X is a `repost` (same platform =
  X), not a `cross_post`. The "platform" axis wins; the account is incidental.
- **`repostedFromItemId` always points to the earliest member of the cluster**,
  not the immediate prior post. A repost-of-a-repost should still link back to
  the original. Keeps the graph one level deep and the rollups correct.
- **`repurposed` is not on this axis.** It's different content derived from a
  parent, not the same content re-run. Use it only when the derivation is
  automated or explicitly tracked (`sourceClipIdeaId` / `pillarContentItemId`).

---

## What "same content" means

The post is the *same content* as an earlier one if **any** of these hold:

- **Body text is identical** after normalization (lowercase, strip URLs /
  @mentions / #hashtags / emoji / punctuation, collapse whitespace).
- **Body text is near-identical** — token-level Jaccard ≥ 0.6 on the
  normalized text. Catches small rewrites like "I'm still convinced you can
  become a millionaire **simply…**" vs "**It's 2026 and** I'm STILL convinced
  you can become a millionaire…".
- **Same archived media** — `contentMediaUrl` (or the first
  `productionItemMedia` entry) points to the same S3 key. Strongest signal
  for image/video reposts where the caption was rewritten.
- **Same transcript** — `transcripts.fullText` matches another item's
  transcript with high overlap. Useful for short-form video where the body
  text is empty or unhelpful.

The post is *not* the same content (do not classify as repost/cross-post) if:

- It quotes, replies to, or references the original. A QT or reply post is
  its own original.
- It uses the same hook or topic but a different angle, claim, or example.
  "Five reasons why X" and "Three reasons why X" are not the same post even
  if every word in the shorter title appears in the longer one.
- It's a clip cut from a longer piece. That's `repurposed` with a
  `sourceClipIdeaId` set, written by the clip-idea pipeline — not a repost.

---

## Cross-account semantics

Posts move across accounts owned by the same brand all the time
(@thepatwalls → @starter_story → @patrickwalls). The classification is
independent of which account owns the row:

| Earlier post | Later post (same content) | Source type | Why |
|---|---|---|---|
| @thepatwalls X | @thepatwalls X (re-run) | `repost` | Same platform |
| @thepatwalls X | @starter_story X | `repost` | Same platform — account doesn't matter |
| @thepatwalls X | @starter_story Threads | `cross_post` | Different platform |
| @thepatwalls X | @starter_story YouTube Community | `cross_post` | Different platform |
| @starter_story IG Reel | @starter_story TikTok | `cross_post` | Different platform |
| @starter_story IG Reel (with new caption) | @starter_story IG Reel | `repost` if same media archive |

When in doubt, the joined `accounts.platform` value is the source of truth
for "platform". The legacy `productionItems.platform` JSONB column is being
phased out (see `docs/features.md`) and should not be used by new code.

---

## Data invariants

| `sourceType` | `repostedFromItemId` | `sourceClipIdeaId` | `pillarContentItemId` |
|---|---|---|---|
| `original`   | NULL             | NULL             | NULL (allowed when distinct from any pillar) |
| `repost`     | **REQUIRED** — earliest item in cluster | NULL | NULL |
| `cross_post` | **REQUIRED** — earliest item in cluster | NULL | NULL |
| `repurposed` | NULL             | OPTIONAL — set when promoted from a clip idea | **REQUIRED** — points at the parent pillar |

A row that violates this table is mis-classified. The cleanup script
(`scripts/backfill-repost-classification.mjs`) enforces the first three
rows. `scripts/migrate-source-type-consolidation.mjs` (one-shot,
2026-05-11) collapsed `clip` into `repurposed` and reclassified
derivative-format originals.

The detail-page picker for source type was removed on 2026-05-11. Source
type is no longer editable from the UI — it's set exclusively by the
system flows below and corrected in bulk via the consolidation script.

---

## Where each value is written

| Value | Write site | Trigger |
|---|---|---|
| `original` | `src/lib/services/notion-sync.ts` | every :30 cron, YouTube long-form |
| `original` | `POST /api/production-items` | manual create dialog |
| `original` | `POST /api/production-items/[id]/duplicate` | always — duplicates start fresh |
| `original` | `POST /api/production-items/preview-link` → save | "Add post from link" flow |
| `original` | `src/lib/services/account-content-sync.ts` | per-account content sync |
| `repost` | `POST /api/production-items/[id]/repost` | user button on item detail / repost queue |
| `repost` | `scripts/backfill-repost-classification.mjs` | one-shot cleanup; --apply commits |
| `cross_post` | `POST /api/production-items/[id]/cross-post` | user button on item detail; v3 cross-post queue modal calls the same route with `assign:true` (creates `Assigned` rows). The candidate finder (`src/lib/services/cross-post-candidates.ts`) is read-only — it never writes. |
| `repurposed` | `src/jobs/tasks/threshold-monitor-sweep.ts` | hourly :15, parent crosses `viewThreshold` |
| `repurposed` | `src/lib/services/clip-idea-generate.ts` | clip-idea generation spawns paired rows (sourceClipIdeaId set) |
| `repurposed` | `src/lib/services/promote-clip-idea.ts` | `assignClipIdea` and `createClipIdeaInDescriptFull` paths |
| `repurposed` | `scripts/migrate-source-type-consolidation.mjs` | one-shot 2026-05-11 consolidation |

When adding a new write site, append a row to this table and update
`docs/automation.md` Post Lifecycle if it's a scheduled or auto-triggered
flow.
