Status: active

# My day — every person sees what's waiting on them, and does it from one screen

Started 2026-10-22 (lap 5). Follows publish-day (shipped, measuring).

## Evidence

**Usage** (content_events 30 days, usage_events 2 days, to 2026-10-22):
- Half the people who act in a month only move statuses: one editor 24 Assigned → Review on 19
  days, another 19 Assigned → Review on 14 days, a futurepedia reviewer 40 Review → Ready To
  Publish on 9 days (all on another editor's posts, ~12 h after they reached Review), a
  science-of-scaling reviewer 11 Review → Ready on 7 days. Nobody is assigned as reviewer in the
  data; each brand's reviewer is simply whoever approved its posts last month.
- `/my-work` (Your turn / Waiting on others) exists but is only reachable from ⌘K search:
  nobody opened it in 2 days of usage. `/notifications` wasn't opened either, and the inbox is
  noise: 478, 250, 174, 168, 129 unread for the five most-notified people.
- The status-only editor reaches work through item pages one at a time (5 content-page opens
  in 19 minutes this morning, then one Assigned → Review).
- With the rules below, today: 6 people would see 3–15 posts to review, 8 people 5–36 on their
  turn.

**Their words**: Pat (2026-10-21) wants the app to serve its many users, not just him. No
comments in the app ask for this directly.

**What others do**:
- Linear: Triage has an owner (one person, a rotation or on-call) who is notified when work
  arrives, and single-key actions (1 accept, 3 decline, H snooze). My Issues is the per-person
  list. https://linear.app/docs/triage
- Adobe Workfront + Frame.io: approvals land in a "My Approvals" widget on Home; reviewers and
  approvers are separate roles, and nothing moves until the approver decides.
  https://experienceleague.adobe.com/en/docs/workfront/using/review-and-approve-work/document-reviews-and-approvals/review-and-approve-documents/review-with-frame
- Lesson: the per-person list must be on the main screen with a count, and the reviewer
  role needs a home of its own (not mixed into "your items").

## Milestones (one lap each, each with a What's new card)

1. **My Work in the header with a count, and a To review list** (2026-10-22, this lap): the
   header button shows your turn + to review; `/my-work` gets To review (Review items on brands
   you approved last month, oldest first, with the editor's name). Your turn = Assigned / Ready
   To Publish only (Review is the reviewer's turn now).
2. **Act from the row**: "Send to review" on Assigned rows and "Approve" / "Send back" (with a
   note that lands as a comment) on To review rows, without opening the item. Keyboard: j/k to
   move, a approve, b send back.
3. **What changed since you last looked**: per-row "new comment" / "sent back" dots, and the
   comment preview on the row. Replaces the ignored inbox for the people who never open it.
4. **Morning email digest** (opt-out): one email a day with your count and the top 5, instead
   of one email per assignment.

## Watch next

- Do people click the button (`my-work:header`) and open `/my-work`? Which roles?
- Does the review wait (Review → next status, hours) drop for brands with a known reviewer?

## Done when

At least 6 of the ~12 monthly-active people open `/my-work` on 3+ days a week, and the median
time an item sits in Review drops below 6 h (from ~12 h on futurepedia).

**The number**: distinct people with `/my-work` views per week; median hours in Review per brand
(`content_events` status_change pairs).
