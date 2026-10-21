# Hub & Spoke scout

The `/build` loop's notebook: what people actually do, candidates considered (built, rejected,
why), and what other tools ship. Newest first. Never re-propose something listed here without
new evidence.

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
- 2026-10-21 Publish screen (`/[brand]/publish`, project publish-day milestone 1). Card
  `2026-10-21-publish-screen`.
- 2026-10-21 What's new pop-up + usage tracking (interactive session, not the loop) — the
  foundation this loop reads and writes. Card `2026-10-21-whats-new`.
