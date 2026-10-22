# Hub & Spoke scout

The `/build` loop's notebook: what people actually do, candidates considered (built, rejected,
why), and what other tools ship. Newest first. Never re-propose something listed here without
new evidence.

## 2026-10-22 — lap 6 (project lap: my-day, milestone 2)

**Learned** (2 days of usage)
- Since My Work shipped (09:44 UTC) one person opened the app (the home page, 7 times) and nobody
  opened `/my-work` yet; the curator and the status-only editors haven't been in. Too early.
- The curator is still the whole pipeline (3,145 actions / 30 days); this week's throughput is on
  pace (235 items, 30 clips Mon–Wed, 13 designs, the most yet). No failed renders.
- Sentry: nothing new people hit (an info-level HTTP overhead on /queue, 2 users); slow p95s are
  cold starts on /api/warm and the queues — ops loop.
- Every brand has Assigned / Review / Ready To Publish, so row actions apply everywhere.

**Did the last features land?** `my-work-waiting`: 0 opens in 4 h — the people it is for (two
editors, two reviewers) act every few days, so the moment hasn't come. `clip-editor-next-idea`,
`publish-way-in`: still no marks; the curator hasn't been in since.

**Outward** (short; the Linear/Workfront notes from lap 5 still hold)
- Linear Triage: a single key per decision on the focused row (1 accept, 3 decline), j/k to move.
  https://linear.app/docs/triage — the model for the My Work keys.
- Frame.io review links (legacy): the reviewer sets Approved / In Progress / Needs Review in one
  click from the review page and the project is notified.
  https://help.frame.io/en/articles/1161479-review-links-explained-for-clients — a decision is
  one click where you look at the work; our send-back note is optional (the status-only
  reviewers rarely comment today).

**Candidates**
- → building: **Act from the My Work row** (my-day M2). source: usage (status-only people move
  one item at a time through item pages)
- What changed since you last looked (my-day M3). source: usage (ignored inbox)
- The paste box on the Cross-post tab rows (still open). source: usage

## 2026-10-22 — lap 5 (project lap: my-day, milestone 1; publish-day closed to measuring)

**Learned** (2 days of usage)
- Half of the ~12 people who act in a month only move statuses, every few days: two editors move
  Assigned → Review (24 on 19 days, 19 on 14 days), two reviewers move other people's posts
  Review → Ready To Publish (40 on 9 days, ~12 h after they reached Review; 11 on 7 days). No one
  is assigned as reviewer; the history says who it is per brand.
- `/my-work` and `/notifications` were opened by nobody. My Work is only in ⌘K search; the
  inbox has 129–478 unread for the five most-notified people.
- The curator hasn't worked since lap 4 (last action 02:23 UTC). Pipeline on pace (232 items,
  30 clips Mon–Wed), no failed renders, Sentry nothing user-facing, slow pages are ops-loop cold
  starts.

**Did the last features land?** `clip-editor-next-idea` (05:30) and `publish-way-in` (00:58):
no marks yet. The curator hasn't opened the editor or published since either shipped, so the
moment hasn't come. `publish-screen`: 9 opens by 3 people, still no links pasted. publish-day's
4 milestones are all out, so it moves to measuring.

**Outward**
- Linear Triage: a named owner (person, rotation or on-call) is notified when work arrives;
  single keys accept/decline/snooze. https://linear.app/docs/triage
- Workfront + Frame.io: a "My Approvals" widget on Home is where reviewers find work; approvers
  are a role of their own.
  https://experienceleague.adobe.com/en/docs/workfront/using/review-and-approve-work/document-reviews-and-approvals/review-and-approve-documents/review-with-frame
- Lesson: the per-person list has to sit on every page with a count, and reviewing needs its own
  list.

**Candidates**
- → building: **My Work in the header with a count + To review** (project my-day M1).
  source: usage (status-only people, unopened /my-work)
- Act from the My Work row (approve / send back / send to review) — my-day M2. source: usage
- The paste box on the Cross-post tab rows (still open). source: usage

## 2026-10-22 — lap 4 (polish lap)

**Learned** (2 days of usage)
- At 02:14–02:16 UTC the curator opened the clip editor on 11 different ideas in the
  repackage-section queue in two minutes, then kept one (assigned 02:22). The editor is how they
  compare ideas, but each look was close → click the next row → wait for the editor to open.
- The curator still does the whole pipeline: 278 items created, 344 editor changes and 422
  status changes in 30 days. After cross-posting they often hand a post to another editor
  (editor change + back to Assigned). The clip editor (15 opens, curator only) is their third
  most-opened screen after the content page and production.
- Sam lives on formats (17), queue (16) and newsletters (12). Five people have now seen a
  What's new pop-up.
- Pipeline: 231 items and 30 clips rendered this week so far (Mon–Wed), on pace. No failed
  renders. Sentry has nothing user-facing (an info-level overhead event and the boot lock
  warning). Slow pages: `/api/warm` cold starts (ops loop) and one 10 s draft POST.

**Did the last features land?** `publish-way-in` (shipped 00:58 UTC): no `publish:way-in:*`
marks yet. The curator hasn't published anything since then (their last batch was 23:37), so
the moment hasn't come. Check next lap. `publish-screen`: opened by 3 people, no links pasted.

**Outward**
- Frame.io (V4 viewer): `[` and `]` go to the previous and next asset, and the arrows step frames.
  Reviewers move through a folder without going back to the grid.
  https://help.frame.io/en/articles/10535490-move-smoothly-in-the-viewer-with-asset-navigation
- Opus Clip's editor shortcuts are about the timeline (frames, split, zoom), with no clip-to-clip
  jump. You go back to the project's clip list each time.
  https://help.opus.pro/docs/article/keyboard-precise-editing
- Lesson: review tools let you move between items from inside the viewer. Our editor is where the
  curator compares ideas, so the way to the next idea belongs in its header.

**Candidates**
- → building: **Previous / Next idea in the clip editor** ("‹ 2 of 12 ›" plus `[` / `]`),
  walking the queue table's clip rows in their sort order. source: usage (the curator's 11
  editor opens in 2 minutes on 2026-10-22)
- Next after this: on Kill idea or Export, open the next idea automatically. That only makes
  sense if `clip-editor:next-idea` gets used. source: usage
- The paste box on the Cross-post tab rows (still open, from lap 3). source: usage

## 2026-10-22 — lap 3 (project lap: publish-day, milestone 4 second half)

**Learned** (1 day of usage)
- The curator opened the Publish tab twice for about 10 s (23:12, 23:32 UTC). In between, they
  cross-posted one pillar to 6 platforms from the content page's Cross-post tab, then pasted 5
  live links back one at a time: production → item page → Publish dialog → production, about
  1.5 minutes each. No `publish:link-pasted` marks yet. The new tab never met them where they
  publish: right after cross-posting, on the content page.
- 3 people opened Publish (curator, Sam, Pat); only Sam clicked a What's new card. Content page
  (26 opens, 4 people) and production (22) are where the work happens.
- Pipeline: 229 items created and 28 clips rendered so far this week (Mon–Wed), on pace with last
  week. No failed renders. Sentry has nothing user-facing (an info-level overhead event and the
  boot lock warning). Slow: `/api/warm` p95 20 s (cold starts, ops loop) and one 10 s draft POST.
- Pat's words (21 days): mostly newsletters, background removal and the loops. He also mentioned
  a line-graph request that went missing (10-20), but there's no detail to build from.

**Did the last features land?** `publish-screen` / `publish-grouped-live`: opened by 3 people,
links pasted by nobody. The reason is the way in, not the screen (above). This lap builds that.

**Outward**
- Publer (reminder publishing): tapping the reminder's "Open in app" marks the post as posted on its
  own; skip that, and you mark it by hand from the calendar or post list. The record is kept at the
  moment of posting, from where you post.
  https://publer.com/help/en/article/how-to-mark-posts-as-successfully-posted-qxmpvs/
- Planable: "marked as published" is a per-post status flag (a flag icon) for posts that went out
  outside Planable. You set it on the post itself, not from a separate list.
  https://help.planable.io/hc/en-us/articles/21715457342492-Post-status
- Lesson: a separate publish list only gets used if it's one click from where the posting
  happens. For us, that's the content page right after cross-posting.

**Candidates**
- → building: **Way in to Publish** from the Cross-post tab and the Publish dialog, landing on
  that video's posts. source: usage (the curator's 5 one-at-a-time publishes on 2026-10-21)
- The paste box right on the Cross-post tab's rows (no page change). source: usage. Next lap,
  if the way in isn't taken.
- Curator keyboard triage of the cross-post queue (still open). source: usage

## 2026-10-21 — lap 1 (project lap: publish-day, milestone 1)

**Learned**
- 12 people acted in 30 days. The daily curator did ~3,100 actions; ~1,000 of them are
  "mark published": status + link + date, ~11 posts a day, almost all cross-posts across ~6
  platforms per pillar. The heaviest editor does ~50 a month.
- Status-only users (four people, 12–23 status changes each) mostly move Assigned → Review and
  Review → Ready To Publish.
- Only 1 day of usage_events so far: one person opened /production. It's too early to call any
  screen unused.
- Pipeline: items created fell to 205 this week (Mon–Wed only, partial). The kill spike on
  Oct 12 (98) was a one-off. Clip renders are at 28 so far this week, against 44 last week.
- Friction: no failed renders. Sentry: nothing user-facing besides an info-level HTTP overhead
  event. Slow p95 tails (/api/repost-queue 9s, /api/cross-post-queue 8s, /[brand]/queue 5s)
  look like cold starts, since p50 is under 125 ms. Watch them, but that's the ops loop's job.

**Outward**
- Buffer notification publishing: you post natively and the post lands in "Sent", with no
  paste-back. https://support.buffer.com/hc/en-us/articles/360039027053
- Airtable calendars: status + URL field per record, which is our chore exactly.
  https://draft.dev/learn/airtable-content-calendar
- Lesson: make the record appear by itself (detection), or else make the paste-back one
  keystroke on one screen.

**Candidates**
- → building: **Publish screen**: paste link + Enter per row for every Ready To Publish post.
  source: usage (the curator's ~11 manual publishes a day)
- Curator keyboard triage of the cross-post queue (261 created + 65 dismissed / 30 days, one at a
  time). source: usage
- Re-render friction in the clip editor (still open from the baseline). source: usage

## 2026-10-21 — baseline (written when the loop was created)

**People** (content_events, 30 days; usage_events starts today so screens are empty for now):
- ~12 people act in a month; ~20 accounts never do. The pipeline is carried by two people:
  a curator acting every single day (~3,100 actions: content edits, status changes, editor
  assignments, ~270 items created) and an editor (~1,200 actions, the heaviest clip-editor user).
- Admin/producers (Pat, Sam, two producers) act a few times a week — they review, kill, assign.
- Several people only ever change statuses (14–19 active days, nothing else): they use the app as
  a checklist. What would make that faster or unnecessary?

**Pipeline** (weekly, 8 weeks): ~400–570 items created a week; Descript actions went from ~100/week
(mid-September) to zero by Oct 19 while in-app clip renders went 0 → 44/week — the clip editor
replaced Descript. Design-editor renders are starting (13 this week). One kill spike (98 in the
week of Oct 12). Cross-posts steady at 60–80/week.

**Errors**: no failed clip/design renders in 14 days (only superseded re-renders by one editor —
14 in a week: re-rendering the same clip is a friction signal worth a look).

**Candidates** (unscored — lap 1 decides with the usage data that arrives this week):
- Curator throughput: the daily curator does hundreds of one-at-a-time status/editor changes —
  keyboard triage or bulk actions on the queues. source: usage
- Re-render friction in the clip editor (14 superseded renders by one person in a week): what did
  they change each time, and can the editor get it right the first time? source: usage
- Status-only users: a lighter "what's waiting on me" view for people who only flip statuses.
  source: usage

## Built
- 2026-10-22 Approve / Send back / Send to review from My Work rows + keys (project my-day
  milestone 2). Card `2026-10-22-my-work-row-actions`.
- 2026-10-22 My Work in the header with a count + To review (project my-day milestone 1).
  Card `2026-10-22-my-work-waiting`.
- 2026-10-22 Previous / Next idea in the clip editor (polish). Card
  `2026-10-22-clip-editor-next-idea`.
- 2026-10-22 Way in to Publish from the content page (project publish-day milestone 4). Card
  `2026-10-22-publish-way-in`.
- 2026-10-21 Publish screen (`/[brand]/publish`, project publish-day milestone 1). Card
  `2026-10-21-publish-screen`.
- 2026-10-21 What's new pop-up + usage tracking (interactive session, not the loop) — the
  foundation this loop reads and writes. Card `2026-10-21-whats-new`.
