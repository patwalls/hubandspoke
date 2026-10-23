# Hub & Spoke scout

The `/build` loop's notebook: what people actually do, candidates considered (built, rejected,
why), and what other tools ship. Newest first. Never re-propose something listed here without
new evidence.

## 2026-10-23 — lap 10 (polish lap)

**Learned** (3 days of usage, 30 days of actions)
- The curator still publishes 10–17 posts a day by hand and opened the Publish tab 0 times on
  10-22. Their flow at 19:07: publish the X pillar, open its Cross-post tab, create 4
  cross-posts, then for each one go production → item page → paste link → back, about 1.5 min
  each. The way in (`publish:way-in:*`) has never been clicked.
- John re-exports clips a lot: 80 renders over 37 clips in 14 days. 15 of 48 re-renders had a
  doc identical to the one before, and 5 of those since 10-16 came 1–4 minutes after a finished
  render. Why is still open (couldn't see the file? didn't trust it?).
- Sentry: "Large HTTP payload" on `/[brand]/content` (`/api/reports/content`) has 9 users, but
  it has been trimmed three times already. `/[brand]/queue` p95 is 11 s against a p50 of 11 ms,
  which is cold starts and belongs to the ops loop. No failed renders.
- Pipeline on pace (411 items, 42 clips, 13 designs this week).

**Did the last features land?** `handoff-button`: yes, the curator used it twice
(`handoff:send-to-review`). `my-work-news` / `row-actions`: still only Pat and Sam. The
status-only people reach work through item pages and the pop-up. `publish-way-in`: never
clicked; the curator's eyes are on the cross-post list, not a banner. This lap builds on that.
`clip-editor-next-idea`: has no mark, so there's no way to tell.

**Outward**
- Gain: with manual publishing you post natively, then mark the post published on the calendar
  entry itself, and it turns Live. The record is kept where the post sits.
  https://help.gainapp.com/article/212-how-do-i-mark-content-as-published
- Sprout Social: published posts can't be edited, only duplicated. Their record is the post
  itself. https://support.sproutsocial.com/hc/en-us/articles/38265010643469
- Lesson (third time): the link box goes where the post is created, not on a separate screen.

**Candidates**
- → building: **Paste live links on the Cross-post tab**, with a box per ready cross-post and
  Enter to go to the next one. source: usage (curator, ~11 a day, 4 trips on 10-22 alone)
- Re-export of an unchanged clip: show "Up to date: rendered 2 min ago" with the download, in
  place of a fresh 50 s render. source: usage (John, 5 in a week). First check what he does
  right after a render.
- My Work's row actions should hand off the editor too (still open). source: usage

## 2026-10-22 — lap 8 (project lap: my-day, milestone 3)

**Learned** (2 days of usage, 30 days of actions)
- Nothing new broke: no failed renders, Sentry only has worker-lock warnings and an info-level
  HTTP overhead on /queue (ops loop). This week is on pace (408 items, 39 clips, 13 designs).
- The status-only people (Noman, Kate, Nuriel) open the app through item pages and the What's
  new pop-up, never `/my-work`. Only Pat and Sam open My Work (20 views); row actions were used twice.
- Comments are where handoffs happen today: 8 people have 38 open, assigned posts with a comment
  from someone else in 30 days, 21 of them newer than that person's last touch on the post
  (Saj 7 of 9, Kate 5 of 5). The inbox that would tell them is ignored (129–478 unread).

**Did the last features land?** `handoff-button` (19:00): no way to tell yet — it has no mark of
its own and the status changes look the same as manual ones; add a mark next time it's touched.
`my-work-row-actions`: Pat + Sam once each. `clip-editor-next-idea`, `publish-way-in`: still
nothing; the curator's sessions since have been reposts and production.

**Outward**
- Linear Inbox: one notification per key event on your issues, read/unread with U, "show unread
  first" sorts what's new to the top, and opening one lets you act in place.
  https://linear.app/docs/inbox
- Lesson: our people don't open an inbox, so the unread mark and the last comment go on the
  My Work row they already scan.

**Candidates**
- → building: **New comments + send-backs on My Work rows** (my-day M3). source: usage (21 unseen
  comments on open posts, inbox ignored)
- A `content:handoff` mark on the one-click handoff button, so we can tell if it landed. source:
  usage. Tiny; fold into the next lap that touches the content page.
- My Work's row actions should hand off the editor too (still open from lap 7). source: usage

## 2026-10-22 — lap 7 (polish lap)

**Learned** (2 days of usage, 30 days of actions)
- The team passes work along with two clicks every time: set the editor to the next person, then
  move the status. ~200 such pairs in 30 days: John 53 Assigned → Review (to the brand's
  reviewer), Andrew 42 Review → Ready To Publish (editor back to John), the curator 34 to Review
  + 24 back to Assigned. So the editor field *is* the handoff, and every brand has one clear
  reviewer by history (futurepedia Andrew, matg Lauren, MFM Cassie, science-of-scaling Nuriel).
  My Work's row actions move only the status, not the editor.
- Today John exported 4 clips and handed each off from the content page right after the export
  (editor + status, ~3 s apart). Andrew opened two items from production and approved each with
  the same two clicks.
- Sam used My Work's row action once (`my-work:send-to-review`); Pat and Sam opened `/my-work`.
  The status-only people haven't been in since it shipped.
- Pipeline: 385 items, 38 clips, 13 designs so far this week (Mon–Thu), on pace. No failed renders.
  Sentry: nothing new people hit; slow p95s are `/api/warm` cold starts (ops loop).

**Did the last features land?** `my-work-row-actions`: 1 use by Sam within hours. `my-work-waiting`:
2 people (Pat, Sam). `clip-editor-next-idea`, `publish-way-in`: no marks yet. The curator's last
session (00:07–02:23 UTC) was reposts and clip comparing; they compared 11 ideas *before*
next-idea shipped (05:30).

**Outward**
- Asana rules can assign a fixed person when a field changes, but users have asked for years to
  "assign back to the original owner" and there's no rule for it.
  https://forum.asana.com/t/re-assigning-tasks-back-to-original-owners/148333 ,
  https://help.asana.com/s/article/request-a-task-review-with-a-simple-automation
- Lesson: we have the history Asana lacks (who sent it, who reviews each brand), so the
  hand-back can be one click with the right name already on the button.

**Candidates**
- → building: **One-click handoff** on the content page ("Send to review → Andrew",
  "Approve → back to John"). source: usage (~200 two-click handoffs / 30 days)
- My Work's row actions should hand off the editor too (same rules), so both surfaces agree.
  source: usage. Small; next my-day lap.
- The paste box on the Cross-post tab rows (still open). source: usage

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
- 2026-10-23 Paste cross-post live links on the Cross-post tab (polish). Card
  `2026-10-23-cross-post-paste`.
- 2026-10-22 New comments + send-backs on My Work rows (project my-day milestone 3). Card
  `2026-10-22-my-work-news`.
- 2026-10-22 One-click handoff on the content page (polish). Card `2026-10-22-handoff-button`.
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
