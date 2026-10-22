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
2. **Grouped by pillar, with the post kit on the row** (2026-10-21, shipped with 3 and 4; Pat approved
   idea 95ec60 from the Cockpit inbox): rows sit under their pillar with "n of m left". Each open row
   has Copy caption (its own body, else the body of the post it was cross-posted from) and Download
   media (presigned attachment links).
3. **"Looks live" detection** (2026-10-21, shipped): the hourly `publish-live-sweep` runs the
   schedule-reconcile matcher over Ready To Publish items against sync-discovered posts since the
   item went ready. ≥85 merges on its own, 55–84 shows "Looks like this is already live" on the row
   with That's it / Not it. Haiku only, no SC credits.
4. **A way in where they work** (2026-10-22, shipped): the Publish tab shows the brand's ready
   count; the content page's Cross-post tab ("N cross-posts are ready → Open Publish tab") and the
   Publish dialog on a Ready post ("N more from this video") open `/[brand]/publish?focus=<id>`
   with that video's group on top and the cursor in its first box. Why: on 2026-10-21 the curator
   opened the Publish tab for ~10 s, then cross-posted a pillar to 6 platforms and pasted 5 links
   back through production → item → dialog → production, ~1.5 minutes each.

## Watch next

- Do people take the way in (`publish:way-in:cross-post-tab`, `publish:way-in:dialog`), and do
  `publish:link-pasted` marks follow within minutes? If the curator still uses the dialog after a
  week, the next step is the paste box on the Cross-post tab itself (no page change at all).

- Do the 55–84 suggestions get confirmed or rejected (`publish:live-confirmed` vs
  `publish:live-rejected`)? A lot of rejects means the Ready window is too wide.
- How many Ready items the sweep merges on its own (`publish-live-sweep merged=` in worker logs,
  `status_change` to Published with `user_id IS NULL` on non-Scheduled items).
- Is Download media used at all (`publish:media-downloaded`)? Most cross-posts have no media of their own.

## Done when

At least 60% of the week's Ready To Publish → Published transitions happen on `/[brand]/publish`
or through detection rather than the per-item dialog.

**The number**: `publish:link-pasted` + `publish:live-confirmed` marks + sweep auto-merges
÷ `status_change` events to Published, weekly.
