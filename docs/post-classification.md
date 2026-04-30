# Post Classification

Canonical definitions for the `productionItems.sourceType` column. Read this
before adding any new write site, classifier, or report that branches on
source type. Cross-references: schema in `src/lib/db/schema.ts:179-198`,
display in `src/components/ui/source-badge.tsx`, write sites listed at the
bottom of this doc.

---

## The five values

| Value | Meaning |
|---|---|
| `original` | The first time this content was posted on this platform. Default. |
| `repost` | Same content, **same platform**, posted again — same account *or* a different one. |
| `cross_post` | Same content, **different platform** from the original. |
| `clip` | Short-form derivative cut from a longer piece (a pillar). Different content, same source. |
| `repurposed` | Auto-created by `threshold-monitor-sweep` when a pillar crosses a child format's view threshold. Different content, same pillar. |

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
- **`clip` and `repurposed` are not on this axis.** They're different content
  derived from a parent, not the same content re-run. Use them only when the
  derivation is automated or explicitly tracked (`sourceClipIdeaId` /
  `pillarContentItemId`).

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
- It's a clip cut from a longer piece. That's `clip`, set via the clip-idea
  triage flow, not a repost.

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
phased out (see `docs/features.md` line 69) and should not be used by new
code.

---

## Data invariants

| `sourceType` | `repostedFromItemId` | `sourceClipIdeaId` | `pillarContentItemId` |
|---|---|---|---|
| `original`   | NULL             | NULL             | NULL (allowed when distinct from any pillar) |
| `repost`     | **REQUIRED** — earliest item in cluster | NULL | NULL |
| `cross_post` | **REQUIRED** — earliest item in cluster | NULL | NULL |
| `clip`       | NULL             | **REQUIRED**     | typically points at the source pillar |
| `repurposed` | NULL             | NULL             | **REQUIRED** — points at the parent pillar |

A row that violates this table is mis-classified. The cleanup script
(`scripts/backfill-repost-classification.mjs`) enforces the first three
rows; manual operator changes via the detail-page picker also enforce them.

---

## Where each value is written

| Value | Write site | Trigger |
|---|---|---|
| `original` | `src/lib/services/notion-sync.ts` | every :30 cron, YouTube long-form |
| `original` | `POST /api/production-items` | manual create dialog |
| `original` | `POST /api/production-items/[id]/duplicate` | always — duplicates start fresh |
| `original` | `POST /api/production-items/preview-link` → save | "Add post from link" flow |
| `repost` | `POST /api/production-items/[id]/repost` | user button on item detail |
| `repost` | `src/lib/services/evergreen-scan.ts` (Phase B) | daily 15:00 cron, refills Idea queue |
| `repost` | `scripts/backfill-repost-classification.mjs` | one-shot cleanup; --apply commits |
| `cross_post` | `POST /api/production-items/[id]/cross-post` | user button on item detail |
| `cross_post` | `src/lib/services/cross-post-scan.ts` | "Populate queue" button on `/[brand]/queue` |
| `clip` | `POST /api/production-items/[id]/clip-ideas/generate` | sibling row at clip-idea generation |
| `clip` | `POST /api/clip-ideas/[id]/triage` (and create-in-descript variants) | flips existing sibling, no new insert |
| `repurposed` | `src/jobs/tasks/threshold-monitor-sweep.ts` | hourly :15, parent crosses `viewThreshold` |
| `original` → `repost` (PATCH) | `PUT /api/production-items` (route.ts:364-519) | operator edits source type via detail-page picker |

When adding a new write site, append a row to this table and update
`docs/automation.md` Post Lifecycle if it's a scheduled or auto-triggered
flow.
