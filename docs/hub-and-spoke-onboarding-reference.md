# Hub & Spoke — Onboarding Reference

This document describes the product from an end-user perspective. It is intended as source material for writing Loom onboarding scripts, not as a technical reference.

---

## 1. Product Overview

Hub & Spoke is a content production management dashboard. Its job is to track every piece of content a brand produces across all social platforms — from first idea through publishing — and to surface what's worth repurposing.

The name reflects the content model the product is designed around: one long-form YouTube video (the **hub**, or **pillar**) is used to produce many short-form derivatives across other platforms (the **spokes**). Hub & Spoke orchestrates that workflow: it watches pillar performance, suggests clips and repurposes, helps editors draft captions, and reconciles scheduled posts after they go live.

Hub & Spoke is not a publishing tool. It does not post to social platforms on behalf of users (with the exception of TikTok via a direct-publish integration). Its job is to plan, track, and coordinate production.

---

## 2. Main Navigation and Page Purposes

The left sidebar lists every brand the user has access to. Selecting a brand opens its dashboard. There is also a cross-brand **All** view at the top of the list.

### Per-brand pages

| Page | What it's for |
|---|---|
| **Home** (`/[brand]`) | Summary dashboard: weekly production goal, views goal, proven formats tile, recent content performance table |
| **Content** (`/[brand]/content`) | Full content library for the brand. Filter by status, format, account, post type, or origin. Toggle to **Top Bangers** for a ranked view of best-performing posts. Click any row to open the item detail page. |
| **Production** (`/[brand]/production`) | Calendar/timeline of published content with performance metrics |
| **Queue** (`/[brand]/queue`) | Where new ideas are surfaced and assigned. Tabs: All, Repurposed, Triggered, Clip Ideas, Cross-post, Repost, History |
| **Formats** (`/[brand]/formats`) | List of all formats for the brand. Click a format to edit it. |
| **Accounts** (`/[brand]/accounts`) | The brand's social media accounts. Manage sync, view content count, connect TikTok. Sub-pages: Goals, Statuses, Brand Assets, Platform Boundaries |
| **Scheduled** (`/[brand]/scheduled`) | Items currently in Scheduled status. Shows reconciliation suggestions that need human review. |
| **Settings** (`/[brand]/settings`) | Brand-level defaults: default editor, weekly goals, etc. |

### Cross-brand pages

| Page | What it's for |
|---|---|
| **All** (`/all`) | Cross-brand content dashboard and content library |
| **My Work** (`/my-work`) | Items assigned to the current user, across all brands |
| **Coverage** (`/coverage`) | Cross-brand analytics |
| **Settings → Users** | User management and invites |
| **Settings → Brands** | Brand list and creation |
| **Settings → Sync Errors** | View Notion/YouTube/platform sync failures |
| **Settings → Jobs** | Live view of the background job queue |

---

## 3. Brand Onboarding

A **brand** is the top-level organizational unit. Each brand has its own formats, accounts, queue, and content library. Examples: Starter Story, MATG.

To set up a new brand:
1. Go to **Settings → Brands** and create the brand.
2. Set the brand's weekly production goal and weekly views goal (used by the home dashboard to show on-track/behind indicators).
3. Set a default editor (the editor who gets assigned new items when no other editor is specified).
4. Add social media accounts (see Section 4).
5. Create or import formats (see Sections 5–6).
6. Optionally customize the status pipeline under **Accounts → Statuses**.

Brand settings like goals and the default editor can be edited later from the brand's **Settings** page.

---

## 4. Accounts

An **account** represents a single social media channel — one YouTube channel, one Instagram profile, one X account, etc. A brand can have multiple accounts across multiple platforms.

### Adding an account

Go to **Accounts** and click **Add Account**. Select the platform and enter the handle. For LinkedIn, paste the company page URL (not the numeric company ID from the admin dashboard). For YouTube long-form, check whether this account should be synced from Notion (only applies to Starter Story's primary YouTube channel).

After creation, Hub & Spoke automatically runs a backfill sync to pull in the account's recent content.

### Content sync

Hub & Spoke periodically pulls new posts from each account using the Scrape Creators API. The sync runs automatically every hour for most platforms. You can also trigger a manual sync from the Accounts table via the **Sync** button (latest posts) or **Backfill** button (historical posts, where supported).

Newsletter accounts (Klaviyo) sync campaigns automatically on their own schedule.

### Account fields that matter

- **Platform** — determines which sync logic and platform constraints apply
- **Handle** — the unique identifier used for deduplication and sync
- **Typefully Social Set ID** — if set, new X and LinkedIn items get a draft automatically created in Typefully
- **Zernio connection** — enables TikTok direct publishing; connect via the **Connect TikTok** button on the Accounts page

### Deleting an account

Deleting an account soft-deletes both the account row and every production item linked to it. You are required to retype the account handle to confirm. This can be undone by a developer running a database restore command.

---

## 5. Pillar and Derivative Formats

Formats define the types of content a brand produces. They are organized in a two-level hierarchy.

### Pillar formats (hubs)

A **pillar format** is a top-level format with no parent. In practice this is almost always the YouTube long-form podcast or interview format — the main content a brand records. Pillar items are the source material that everything else is derived from.

### Derivative formats (spokes)

A **derivative format** has a parent format. It represents a type of content that is created from pillars: clips, reposts to other platforms, cross-posts, Instagram carousels, etc.

Each derivative format has:
- A **parent format** (which pillar it's derived from)
- One or more **publishing channels** (which account + platform it publishes to)
- A **view threshold** (optional) — when a pillar's views cross this number, a repurpose idea is automatically created
- A **Skill** — instructions and context for AI caption generation
- Flags for special behaviors: **Clippable** (AI-generated clip ideas), **Canva** (auto-creates Canva slideshow)

### Proven status

A format is labeled **Proven** when it has consistently performed above average over the last 180 days. **Testing** means it's active but hasn't hit the bar yet. **Stale** means no posts in 90 days. These labels appear on the formats list and in the Queue.

### Clippable formats

When a derivative format is marked **Clippable**, Hub & Spoke automatically generates **Clip Ideas** when a new pillar is transcribed. These ideas appear in the Queue's **Clip Ideas** tab. Each clippable format generates its own set of clip ideas with its own hook style.

### Format name is the linking key

The format name is used as a string key to link production items to formats. Renaming a format updates all linked items automatically, but the rename dialog will show a "blast radius" count first so you know how many rows will be affected.

---

## 6. Format Library

The **Format Library** lets you discover formats that are already working for other brands and copy them into a new brand. This is the primary onboarding shortcut for new brands — instead of building formats from scratch, you can clone proven ones from elsewhere.

Access it from the **Formats** page via **Add Format → From Library**.

The library shows:
- All active formats from other brands that have at least one published post in the last 180 days
- Each format's proven status, platform targets, and up to two clickable example posts
- Clip/Standard and Pillar/Derivative badges

Clicking **Preview Format** shows the full format instructions and configuration (read-only).

Clicking **Add to [Brand]** copies the format into the destination brand. For derivative formats, you must specify which of the destination brand's pillar formats will be the parent. Name collisions return an error — you must either rename or pick a different format.

---

## 7. Queue and Assigning Ideas

The Queue is where production ideas are surfaced and triaged. Every tab shows items the system recommends acting on. The editor's job in the queue is to **assign** (accept and begin production) or **kill** (dismiss permanently or for 30 days).

### Queue tabs

| Tab | What it shows |
|---|---|
| **All** | Everything in Idea or Assigned status, across all source types |
| **Repurposed** (SPOKE) | Algorithmic recommendations for repurposing a pillar into a derivative format, based on pillar strength, format fit, freshness, and pair history |
| **Triggered** | Items automatically created because a pillar crossed a format's view threshold |
| **Clip Ideas** | AI-generated clip suggestions from pillar transcripts. One tab per clippable format. |
| **Cross-post** | High-performing posts recommended for cross-posting to a different platform |
| **Repost** | High-performing older posts recommended for re-sharing on the same platform |
| **History** | Read-only log of items that left the Idea state in the last 30 days |

### Assigning an idea

Click any row to open the triage dialog. Review the context (signal summary, estimated views, format information). Pick an editor, then click the assign/create button. The item moves to **Assigned** status and the editor is notified by email.

For clip ideas, the triage dialog also lets you:
- Choose the "Create in Descript" mode (Precise Cut, Agent Cut, or Full Video)
- Include an intro from the pillar at the top of the clip
- View a preview of the transcript segment

### Killing an idea

"Not interested" hides the item for 30 days on most queue tabs. "Kill this idea" permanently suppresses it (the item won't resurface). On the Repost and Cross-post tabs, a killed item is permanently suppressed for that source.

### Clip Ideas: what happens after assignment

After assigning a clip idea with a Descript cut:
1. Hub & Spoke sends the clip to Descript for editing/assembly
2. Descript renders the MP4 (typically ~2 minutes)
3. The rendered video appears in the item's simulator on the detail page
4. The draft caption algorithm auto-runs and fills in a caption
5. The editor reviews, edits, and publishes

If Descript gets stuck, the item detail page shows a **DescriptStatusPill** with recovery options: Refresh, Re-run, or Start Over.

---

## 8. In Production

Any item that is not Published or Killed is "in production." The key statuses are:

| Status | Meaning |
|---|---|
| **Idea** | Created but not yet assigned to an editor |
| **Assigned** | An editor has been assigned; work has begun |
| **Ready To Publish** | Editing is done; waiting for scheduling or publishing |
| **Scheduled** | Scheduled to publish natively on the platform |
| **Published** | Live |
| **Killed** | Permanently dismissed |

Brands can add custom statuses between Idea and Published via **Accounts → Statuses**. The five statuses above (Idea, Assigned, Scheduled, Published, Killed) are protected and cannot be renamed or deleted.

### Item detail page

Click any item in the Content library or Queue to open its detail page. The layout has:

- **Title and chip row** — account badge, source badge, format, assigned editor, current status. All are editable inline.
- **State row** — Descript status, Canva status, transcript button, estimated views, reference post, published date (once published)
- **Header buttons** — "Publish or Schedule" (or "Edit publish info" once published) and an Actions menu
- **Main panel (Details tab)** — for pre-publish items: a platform simulator on the left (editable caption + media), metadata form on the right. For published items: a live embed of the published post on the left.
- **Activity tab** — every edit, comment, status change, and system event in chronological order
- **Transcript tab** — the full transcript with word-level timestamps (when available)
- **Repurpose tab** — buttons to manually spawn derivative drafts in each child format

### Editing captions

For pre-publish items on supported platforms (X, Instagram, LinkedIn, TikTok), the simulator on the Details tab is fully editable. Type directly in the caption field and the draft auto-saves on blur. Each save creates a new version in the caption history, which is recoverable.

The **Regenerate** button re-runs the AI caption algorithm for that platform. The **Regenerate CTA** button regenerates only the CTA (reply tweet / first comment) without touching the main caption.

While the draft algorithm is running (auto-fired after repurpose/cross-post/clip assignment), the caption field shows an amber "Drafting caption — hold off on typing" banner to prevent edits from being overwritten.

### Publishing an item

Click **Publish or Schedule** in the header. This opens a dialog with two tabs:

- **Publish** — paste the published URL and optionally set the date. Once saved, the item status becomes Published and the left column swaps to a live embed.
- **Schedule** — marks the item Scheduled, captures an optional expected go-live time. Use "No publish date yet" for YouTube videos uploaded as private with an unknown go-live date.

The generic status dropdown in the chip row does **not** allow setting Published or Scheduled directly — those must go through the Publish or Schedule dialog.

### Media upload

Drag and drop or click "Add photo/video" in the simulator to attach media. Platform-specific rules apply:
- X: up to 4 photos OR 1 video (no mixing)
- Instagram Post: up to 10 items (mixed allowed)
- Instagram Reel / TikTok: exactly 1 video

For items with a Descript render or a video sourced from a repost/cross-post, media is attached automatically.

---

## 9. Scheduled and Scheduled (No Date Yet)

### Scheduled (with a date)

Items marked Scheduled have a known expected go-live time. Every 10 minutes, Hub & Spoke checks for newly-published posts on accounts that have pending Scheduled items and tries to automatically match them.

- **Score ≥ 85**: auto-merge — the Scheduled planning item becomes the Published item, absorbing the synced duplicate
- **Score 55–84**: a match suggestion appears on the `/[brand]/scheduled` page for a human to Confirm or Reject
- **Score < 55**: retried next cycle

If no match is found within the timeout window (24 hours for fast platforms, 48 hours for others), the item gets a **Needs Attention** badge and stops auto-matching.

### Scheduled (No Date Yet)

When you don't know the exact publish date — for example, a YouTube video uploaded as private while the go-live date is TBD — check "No publish date yet" in the Schedule dialog.

These items:
- Show a blue "No date yet" chip on the item detail page
- Are checked hourly (instead of every 10 minutes)
- Have a 14-day match window before getting a Needs Attention badge

The matching and merge logic is identical to date-known items once the video goes live.

---

## 10. Published-Content Reconciliation

When an item is Scheduled in Hub & Spoke but published natively (via the platform's own scheduler or a tool like Typefully), Hub & Spoke needs to reconcile the Scheduled planning row with the newly-synced Published row from the platform sync.

This is handled automatically by the schedule-reconcile sweep. The user-facing surface is `/[brand]/scheduled`, which shows:

- Items pending a match
- Match suggestions needing human review (Confirm or Reject)
- Items with a Needs Attention badge (match window expired)

For items that auto-merged successfully, no action is needed — they appear in the Content library as Published with all their pre-publish planning context intact (captions, assigned editor, activity history).

**Typefully integration:** If an account has a Typefully Social Set ID configured, new X and LinkedIn items automatically get a Typefully draft created. The **TypefullyStatusPill** on the item detail page shows sync status and links to the draft. When the post is published via Typefully, a webhook updates the item's status in Hub & Spoke.

**TikTok publishing:** TikTok items have a dedicated **Publish or Schedule** flow that opens a wide two-column dialog showing the actual video and caption. It supports Publish Now (posts immediately) or Schedule (held in Hub & Spoke's queue and posted at the specified time). After publishing, the item transitions to Published automatically.

---

## 11. Common Mistakes and Important Terminology

### Terminology

| Term | Meaning |
|---|---|
| **Pillar** | A long-form YouTube video that is the source of derivative content. Also called a "hub." |
| **Derivative** | Content created from a pillar: clips, reposts, cross-posts, carousels. Also called a "spoke." |
| **Repurpose** | Create a derivative from a pillar (e.g., clip a podcast segment into a Reel) |
| **Repost** | Re-share a previously published piece of content on the same platform |
| **Cross-post** | Share content originally published on one platform to a different platform |
| **Synced content** | Posts pulled into Hub & Spoke from a social platform via the API sync |
| **H&S content** | Content created in Hub & Spoke (vs. synced in from outside) |
| **Clip Idea** | An AI-generated suggestion for a clip, anchored to a specific segment of a pillar transcript |
| **Skill** | The AI instruction set attached to a format; used by the draft algorithm to generate captions |
| **Proven format** | A format that has demonstrated consistent above-average performance over the last 180 days |
| **SPOKE score** | The algorithm score used to rank repurpose candidates in the Repurposed queue tab |
| **View threshold** | A views milestone on a format; when a pillar crosses it, a repurpose Idea is auto-created |
| **Enrichment** | The background process that fetches metadata, media, and bodies from the platform API |
| **Performance decay** | The background process that refreshes view/like/comment metrics on a decay schedule |

### Common mistakes

**Renaming a format** — the format name is the key that links all production items to that format. Before renaming, Hub & Spoke will show a blast-radius count. This is safe to confirm; the rename cascades automatically. But if a format has hundreds of items, this is worth reviewing carefully before confirming.

**Using the status dropdown to publish** — the status dropdown filters out Published and Scheduled. Use the "Publish or Schedule" button in the header. This is intentional: setting a status to Published without providing a published URL creates an inconsistent record.

**Adding accounts with numeric LinkedIn IDs** — LinkedIn company page URLs contain the numeric company ID in the admin dashboard URL (`/company/12345/`), but Hub & Spoke requires the vanity slug (`/company/starterstory`). The add-account form will reject numeric IDs.

**Deleting a format with items** — if you delete a format, its production items lose their format association but are not deleted. This is usually not what you want. Archive or rename the format instead.

**Creating duplicate accounts** — accounts are deduplicated by `(platform, handle)` per brand. If a sync fails because a post already exists under a different account, it means the same content was manually added or synced under a different handle.

**Expecting Hub & Spoke to auto-publish** — Hub & Spoke does not post to social platforms automatically (except TikTok). The workflow ends at "content is ready to publish"; the editor still takes the final action on the platform itself (or via Typefully/TikTok integration).

**Confusion between Scheduled and Ready To Publish** — "Ready To Publish" means the content is done and waiting for the operator to schedule it somewhere. "Scheduled" means it has been scheduled natively on the platform (or via Typefully) and Hub & Spoke is waiting to reconcile the live post.

**Clip Ideas not appearing** — Clip Ideas are only generated for clippable formats after a pillar has been transcribed. Transcription requires the YouTube video to be downloaded first. If no clip ideas appear, check whether the pillar has a transcript (visible on the item detail page's Transcript tab).
