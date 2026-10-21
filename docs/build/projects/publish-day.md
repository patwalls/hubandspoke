Status: active

# Publish day — getting posts from Ready To Publish to Published without the busywork

Started 2026-10-21 (first `/build` lap).

## Evidence

**Usage** (content_events, 30 days to 2026-10-21):
- The daily curator moved ~340 items to Published by hand in 30 days (31 of 31 days): 245
  Ready To Publish → Published, 51 Review → Published, 45 Assigned → Published. Each one is three
  writes (status + publishedLink + publishedDate) made one item page at a time, through the
  content page's Publish dialog.
- Almost all of those are cross-posts: TikTok 52, Facebook 44, LinkedIn 44, Threads 44, X 44,
  YouTube Community 28, YouTube Shorts 24 (all cross-posts), and Instagram Reels/Posts 65. So it
  is one pillar going out to ~6 platforms, then pasted back six times.
- The heaviest editor does the same ~50 times a month (and 27 Ready → Scheduled).
- No usage_events yet for which screen they do it from (recording started 2026-10-21).

**Their words**: `ship signals` doesn't support hubandspoke yet (only bankroll/cockpit/
starter-story-app), so none of Pat's words were read this lap.

**What others do**:
- Buffer (notification publishing): the tool reminds you, you post natively, and the post lands
  in a "Sent" tab. Nobody pastes a link back; Sent is the record.
  https://support.buffer.com/hc/en-us/articles/360039027053
- Airtable editorial calendars: a status field plus a URL field, edited per record. That is
  exactly the one-row-at-a-time chore we have. https://draft.dev/learn/airtable-content-calendar
- Planable / Later: "mark as published" per post on the calendar. Their users ask for bulk.
- Lesson: the best tools make the record of a post appear on its own (auto-publish or detected).
  Where a human has to post natively, the paste-back should be one keystroke per post, all on
  one screen.

## Milestones (one lap each, each with a What's new card)

1. **Publish screen** (2026-10-21, shipped): `/[brand]/publish` lists every Ready To Publish post
   with a link box per row. Paste + Enter publishes it and jumps to the next row, and a link from
   the wrong platform is caught.
2. **Grouped by pillar, with the post kit on the row**: one pillar's cross-posts sit together.
   Each row gets copy-caption and download-media buttons, so the curator posts from this screen
   instead of opening each item.
3. **"Looks live" detection**: for Ready To Publish items on synced accounts, reuse the
   schedule-reconcile matcher (account-content-sync + Haiku) to propose the live post. One click
   confirms it and nothing is pasted.
4. **A way in where they work**: a ready count on the Publish tab and a link from the content
   page's Publish dialog ("publish the rest of this pillar").

## Done when

At least 60% of the week's Ready To Publish → Published transitions happen on `/[brand]/publish`
or through detection rather than the per-item dialog.

**The number**: `publish:link-pasted` marks (plus confirmed detections, once milestone 3 ships)
÷ `status_change` events to Published, weekly.
