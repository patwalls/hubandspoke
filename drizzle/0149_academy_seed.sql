-- Hub & Spoke Academy: starter content, moved over from the Hub & Spoke
-- Operating Guide Google Doc (2026-11-05). Fixed ids + ON CONFLICT so a
-- re-run is a no-op; after this, all edits happen in-app at /academy.
INSERT INTO "academy_categories" ("id", "name", "description", "sort_order") VALUES
  ('6f0c2a10-0001-4a00-8000-000000000001', 'Getting Started', 'Start here: what Hub & Spoke is and how your team will use it.', 0),
  ('6f0c2a10-0002-4a00-8000-000000000002', 'Setting Up Your Brand', 'Get your brand, accounts, assets and goals ready.', 1),
  ('6f0c2a10-0003-4a00-8000-000000000003', 'Daily Workflow', 'How content moves from the Queue to published.', 2)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "academy_videos" ("id", "category_id", "slug", "title", "summary", "video_url", "duration_label", "learn_points", "action_items", "notes", "sort_order") VALUES
  (
    '6f0c2a10-1001-4a00-8000-000000000001', '6f0c2a10-0001-4a00-8000-000000000001',
    'overview-and-tour', 'Hub & Spoke: Overview & Tour',
    'Watch this first — a high-level tour of Hub & Spoke and how the repurposing workflow works.',
    'https://www.loom.com/share/0c064494304c4b64a73138040e60638a', NULL,
    $$[
      {"time": "0:18", "text": "What is Hub & Spoke"},
      {"time": "1:09", "text": "How to use Hub & Spoke for data & metrics"},
      {"time": "3:19", "text": "How the repurposing workflow works"},
      {"time": "4:26", "text": "The two key roles: editors and reviewers"},
      {"time": "5:07", "text": "Live demo (clips): going from video to ready-to-publish clip"},
      {"time": "7:21", "text": "Live demo (carousels): turning a video into a fully designed carousel"}
    ]$$::jsonb,
    $$[
      "Watch the full video overview",
      "Get access to Hub & Spoke (DM Sam Walls)",
      "Define your two roles: who will edit (create the clips) and who will review (provide feedback and publish)"
    ]$$::jsonb,
    NULL, 0
  ),
  (
    '6f0c2a10-1002-4a00-8000-000000000002', '6f0c2a10-0002-4a00-8000-000000000002',
    'set-up-brands-and-accounts', 'Set Up Your Brand & Accounts',
    'Connect your brand''s accounts and get the basics in place.',
    'https://www.loom.com/share/c66fd5f8388746ff909305ea2f590640', '~3 min',
    '[]'::jsonb,
    $$[
      "Upload your brand assets + watermarks (your brand → Accounts → Brand Assets → Upload File)",
      "Create your production goals: an output goal and a views goal (your brand → Accounts → Goals). You can always change these later."
    ]$$::jsonb,
    NULL, 0
  ),
  (
    '6f0c2a10-1003-4a00-8000-000000000003', '6f0c2a10-0003-4a00-8000-000000000003',
    'cross-posts', 'Cross-Posts in the Queue',
    'How to take content from one channel and cross-post it to your others from the Queue.',
    'https://www.loom.com/share/36c10f47c470441abdc03f5be2a67095', '~5 min',
    '[]'::jsonb, '[]'::jsonb, NULL, 0
  ),
  (
    '6f0c2a10-1004-4a00-8000-000000000004', '6f0c2a10-0003-4a00-8000-000000000003',
    'publishing-10-clips-in-10-minutes', 'Publishing 10 Clips in 10 Minutes',
    'Pat moves ten clips through to published in ten minutes, start to finish.',
    'https://www.loom.com/share/e18f378eeca94b5cb61187644f593759', NULL,
    '[]'::jsonb, '[]'::jsonb,
    $$<h2>How the In Production statuses work</h2><p>The <strong>In Production</strong> page is your team's shared board for content being created, reviewed, and prepared for publishing. At every handoff, assign and tag whoever owns the next step so content keeps moving.</p><ul><li><p><strong>Assigned</strong> — when an editor creates a clip or derivative, it's assigned to them and stays here while they work on it.</p></li><li><p><strong>Review</strong> — when it's ready for feedback, the editor moves it to Review, assigns the producer, and tags them in the comments. Revisions bounce between editor and producer while it stays in Review.</p></li><li><p><strong>Ready to Publish</strong> — once the producer approves, they move it here and assign whoever publishes it. Try not to leave content here more than 2–3 days.</p></li></ul><div data-callout="tip"><p><strong>Always use Schedule or Publish Now</strong> from the content's page in Hub &amp; Spoke. That's how Hub &amp; Spoke tracks the post and its views, keeps comments attached, and finds cross-post and repost opportunities later. Scheduled or published content leaves the In Production page automatically.</p></div><p>More: <a href="https://docs.google.com/document/d/17OfTac3fFXVDf07dnu_SbGAAk7vFzlNAoVHMfuryvdo/edit?tab=t.0" target="_blank" rel="noopener noreferrer">Evgeny's day-to-day inside Hub &amp; Spoke as a content producer</a></p>$$,
    1
  )
ON CONFLICT ("id") DO NOTHING;
