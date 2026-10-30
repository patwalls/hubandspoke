import type { FeatureFlag } from "@/lib/feature-flags";

/**
 * The "What's new" cards, NEWEST FIRST. Each one pops up once for every user
 * it applies to, on their next page load after it ships (see `unseenFor`).
 *
 * The product loop (`.claude/commands/build.md`) appends one per shipped
 * feature; humans can too. Rules for a card:
 * - `title` + `body` in plain words for the people using the app (editors,
 *   producers) — what they can do now and where. No jargon, no PR talk.
 * - `href` is where to try it; `[brand]` is filled with the viewer's default
 *   brand. `screen` is the `usage_events.screen` it lives on, so the loop can
 *   read whether it landed.
 * - `audience` narrows who sees it: a feature behind a flag must name the
 *   flag, an admin-only screen must say `adminOnly`.
 * - `id` is unique and never reused: `<YYYY-MM-DD>-<slug>`.
 */
export interface WhatsNewEntry {
  id: string;
  /** ISO timestamp it shipped; users who dismissed the pop-up after this don't see it. */
  shippedAt: string;
  kind: "feature" | "fix";
  title: string;
  body: string;
  href?: string;
  screen?: string;
  audience?: { flag?: FeatureFlag; adminOnly?: boolean };
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: "2026-10-30-api-writes-webhooks",
    shippedAt: "2026-10-30T22:30:00Z",
    kind: "feature",
    title: "The API can now make changes, call you back, and search transcripts",
    body:
      "Create a key with \"Can make changes\" and a script or an AI assistant can move statuses, assign editors, comment, accept or kill clip ideas and add posts by link, with your permissions. Add a webhook to get a call when a post is published, a status moves or a transcript is ready. Plus: search inside every transcript, and read drafts, comments, team members and statuses.",
    href: "/developers",
    screen: "developers",
  },
  {
    id: "2026-10-30-api-and-mcp",
    shippedAt: "2026-10-30T19:30:00Z",
    kind: "feature",
    title: "Hub & Spoke now has an API (and works with AI assistants)",
    body:
      "Pull any content, transcript or performance number into a spreadsheet, Zapier, a script, or Claude and Cursor. Open API & MCP from your account menu, create a key, and copy one of the ready-made snippets. Read-only, so nothing you connect can change anything here.",
    href: "/developers",
    screen: "developers",
  },
  {
    id: "2026-10-30-format-editor-rules",
    shippedAt: "2026-10-30T15:05:00Z",
    kind: "feature",
    title: "See what editors keep changing in each format",
    body:
      "Formats now list what editors keep fixing in that format's AI drafts (a line split, a different opener, a fresh comment keyword). Look for \"edit rules\" on the Formats page, then add a rule to the Skill in one click so every draft follows it.",
    href: "/[brand]/formats",
    screen: "formats:editor-rules",
  },
  {
    id: "2026-10-30-drafts-learn-cross-posts",
    shippedAt: "2026-10-30T07:15:00Z",
    kind: "feature",
    title: "Your cross-post fixes teach the AI drafts too",
    body:
      "When you fix a copied caption on a cross-post before publishing (a name instead of \"He\", a line split in two), the next AI draft in that format now learns from it, the same way it learns from drafts you rewrite.",
    href: "/[brand]/production",
    screen: "drafts:learned-peek",
  },
  {
    id: "2026-10-30-learned-edits-peek",
    shippedAt: "2026-10-30T03:00:00Z",
    kind: "feature",
    title: "See which edits an AI draft learned from",
    body:
      "Above a post's AI draft, a \"Learned from N recent edits\" chip now shows the latest drafts editors rewrote in that format: the AI's version, then what was published. It's how your rewrites shape the next draft.",
    href: "/[brand]/production",
    screen: "drafts:learned-peek",
  },
  {
    id: "2026-10-29-drafts-learn-edits",
    shippedAt: "2026-10-29T22:30:00Z",
    kind: "feature",
    title: "AI drafts learn from your edits",
    body:
      "When you rewrite an AI draft before publishing, the next draft in that format now sees what you changed and does it from the start, so the fixes you keep making by hand should show up less.",
    href: "/[brand]/production",
    screen: "/[brand]/content/[id]",
  },
  {
    id: "2026-10-29-cross-post-clip-caption",
    shippedAt: "2026-10-29T14:20:00Z",
    kind: "fix",
    title: "Cross-posts of a clip start with the clip's caption",
    body:
      "Cross-posting a clip (to TikTok, for example) used to fill the caption with the clip's notes (Source, Timestamp, Angle, Why). It now starts from the caption written on the clip, so there's nothing to delete before you post.",
    href: "/[brand]/production",
    screen: "/[brand]/content/[id]?tab=cross-post",
  },
  {
    id: "2026-10-29-paste-to-publish",
    shippedAt: "2026-10-29T10:00:00Z",
    kind: "feature",
    title: "Paste the live link anywhere to publish",
    body:
      "On a post that's ready to publish, just paste its live link anywhere on the page: the Publish dialog opens with the link filled in, and Enter publishes it. " +
      "No more clicking Publish or Schedule and then the link box first.",
    href: "/[brand]/production",
    screen: "/[brand]/content/[id]",
  },
  {
    id: "2026-10-29-publish-no-duplicates",
    shippedAt: "2026-10-29T01:30:00Z",
    kind: "fix",
    title: "Publishing a link no longer leaves a duplicate post",
    body:
      "When the app had already pulled the live post in from the account, publishing its link used to leave two copies, and its views counted twice. " +
      "Now the copy folds into your post, which keeps its editor, comments and history. A link from another account's post is stopped with a note saying where it lives.",
    href: "/[brand]/production",
    screen: "/[brand]/content/[id]",
  },
  {
    id: "2026-10-28-answer-from-email",
    shippedAt: "2026-10-28T20:00:00Z",
    kind: "feature",
    title: "Answer a review straight from the morning email",
    body:
      "Posts waiting on your review now show how long they've waited in the morning email, with three buttons under each: Approve, Already posted and Not this one. " +
      "Tap one, check the post, and confirm. No digging through the app, and a post you've already posted or don't want stops waiting on you.",
    href: "/my-work/email",
    screen: "/my-work/answer/[id]",
    audience: { flag: "myWorkDigest" },
  },
  {
    id: "2026-10-28-editor-review-notes",
    shippedAt: "2026-10-28T19:00:00Z",
    kind: "feature",
    title: "Review notes show up in the clip editor",
    body:
      "Notes pinned to a moment of a clip now sit as pins on the clip editor's timeline, at the right spot even after you've trimmed. Click one to jump there and mark it done. " +
      "Re-exporting the clip marks the notes left on the old cut done; anyone can reopen one from the post's Activity.",
    screen: "modal:clip-editor",
    audience: { flag: "clipEditor" },
  },
  {
    id: "2026-10-28-resolve-notes",
    shippedAt: "2026-10-28T17:00:00Z",
    kind: "feature",
    title: "Check off review notes when they're handled",
    body:
      "Every comment on a post now has Mark done. Notes pinned to a moment in the video show as \"2 open notes\" next to Activity until someone checks them off, " +
      "so the editor can see what's left to fix and the reviewer can see what's been handled.",
    screen: "comments:resolve",
  },
  {
    id: "2026-10-28-comment-at-playhead",
    shippedAt: "2026-10-28T12:45:00Z",
    kind: "feature",
    title: "Pin a comment to a moment in the video",
    body:
      "On a post's page, play or scrub the video, then click Pin to 0:12 under the comment box before you post. " +
      "Your note shows a 0:12 chip, and clicking it plays the video from that moment, so nobody has to guess what \"near the top\" means.",
    screen: "comments:timecode",
  },
  {
    id: "2026-10-28-edit-clip-chip",
    shippedAt: "2026-10-28T00:15:00Z",
    kind: "feature",
    title: "Edit a rendered clip from its page",
    body:
      "A clip made in the clip editor now shows an Edit clip button at the top of its content page, next to Clip rendered. " +
      "Click it to fix the text or the cut and export again, no need to dig into the status chip.",
    screen: "content:edit-clip",
    audience: { flag: "clipEditor" },
  },
  {
    id: "2026-10-27-production-next-rows",
    shippedAt: "2026-10-27T08:00:00Z",
    kind: "feature",
    title: "The production list marks what's next",
    body:
      "After you publish or send on a post, the production list marks the posts still waiting on you with a green \"Next · Threads\" tag, " +
      "so the same post's other platforms stand out when you head back to the list. Nothing else on the list moves.",
    href: "/[brand]/production",
    screen: "production:next-row",
  },
  {
    id: "2026-10-27-confirm-leave-published",
    shippedAt: "2026-10-27T03:05:00Z",
    kind: "fix",
    title: "A live post asks before it moves back",
    body:
      "Changing the status of a Published post on its page now asks first and names the platform (\"This YouTube post is already Published. Move it back to Review?\"), " +
      "so opening the wrong same-titled cross-post can't quietly unpublish it. Every other status change stays one click.",
    screen: "/[brand]/content/[id]",
  },
  {
    id: "2026-10-26-notification-platform",
    shippedAt: "2026-10-26T23:40:00Z",
    kind: "feature",
    title: "Notifications say which platform the post is for",
    body:
      "When you're assigned or mentioned on a cross-post, the bell now shows its platform before the title (Instagram Reel, TikTok, Threads…), " +
      "so posts with the same title no longer look alike. Open the bell at the top of any page.",
    screen: "notifications:bell",
  },
  {
    id: "2026-10-26-my-work-platform",
    shippedAt: "2026-10-26T18:29:00Z",
    kind: "feature",
    title: "My Work says which platform each post is for",
    body:
      "Cross-posts share their post's title, so every row on My Work now starts with its platform (Instagram Reel, TikTok, YouTube Community…), " +
      "and so does each line of the morning email. Pick the right one without opening it.",
    href: "/my-work",
    screen: "/my-work",
  },
  {
    id: "2026-10-26-my-work-digest-everyone",
    shippedAt: "2026-10-26T17:00:00Z",
    kind: "feature",
    title: "A morning email with what's waiting on you",
    body:
      "Starting tomorrow, on weekday mornings you get one email with how many posts are waiting on you and the five to do first: " +
      "send-backs and new comments at the top. No email on days when nothing is waiting. See it or turn it off from My Work → Morning email.",
    href: "/my-work/email",
    screen: "/my-work/email",
  },
  {
    id: "2026-10-26-next-card-platforms",
    shippedAt: "2026-10-26T14:30:00Z",
    kind: "feature",
    title: "After you publish, pick the next platform right from the card",
    body:
      "Cross-posts of one post all share its title, so the card that pops up after Publish now lists what's left by platform " +
      "(Threads, X, Facebook…). Click the one you're posting next. Up next on the post's page names the platform too.",
    screen: "/[brand]/content/[id]",
  },
  {
    id: "2026-10-26-my-work-waiting",
    shippedAt: "2026-10-26T07:55:00Z",
    kind: "feature",
    title: "My Work shows how long each post has waited",
    body:
      "Your turn and To review now have a Waiting column: how long each post has sat in its status. " +
      "It turns amber after 6 hours and red after a day, and To review puts the longest wait at the top.",
    href: "/my-work",
    screen: "/my-work",
  },
  {
    id: "2026-10-25-publish-link-platform",
    shippedAt: "2026-10-25T01:30:00Z",
    kind: "fix",
    title: "Publish catches a link from the wrong platform",
    body:
      "Paste a TikTok link into an Instagram Reel's Publish box (or any other mix-up) and the post's page now says so " +
      "and keeps Publish off until the link matches, the same check the Publish tab already had. Views keep syncing from the right post.",
    href: "/[brand]/publish",
    screen: "/[brand]/content/[id]",
  },
  {
    id: "2026-10-24-publish-next-card",
    shippedAt: "2026-10-24T18:00:00Z",
    kind: "feature",
    title: "After you publish, the next cross-post is one click away",
    body:
      "Mark a post Published on its page and a card in the corner offers the next post waiting on you, " +
      "starting with the other cross-posts of the same post (or clips of the same video). No trip back to the production list.",
    href: "/my-work",
    screen: "my-work:next-card:same-source",
  },
  {
    id: "2026-10-24-my-work-handed-to-you",
    shippedAt: "2026-10-24T13:45:00Z",
    kind: "feature",
    title: "See who handed you a post",
    body:
      "When someone makes you the editor of a post, its row in My Work now says who and when (\"From Sam · 2h\") " +
      "with a blue dot, until you work on it. New assignments no longer blend in with the rest.",
    href: "/my-work",
    screen: "/my-work",
  },
  {
    id: "2026-10-24-keep-typed-title",
    shippedAt: "2026-10-24T09:30:00Z",
    kind: "fix",
    title: "Your post title stays put when you re-export a clip",
    body:
      "Renamed a clip's post, then exported it again? Before, the title quietly went back to the on-screen hook. " +
      "Now a title you typed stays, and it only follows the hook while you haven't changed it.",
    screen: "modal:clip-editor",
  },
  {
    id: "2026-10-24-approve-after-editor",
    shippedAt: "2026-10-24T05:15:00Z",
    kind: "fix",
    title: "Approve stays one click, even after you set the editor",
    body:
      "Reviewing a post that's already back in its editor's name? The Approve button next to its status no longer " +
      "disappears. It now reads Approve → Ready To Publish and moves it in one click.",
    screen: "/[brand]/content/[id]",
  },
  {
    id: "2026-10-24-my-work-next-card",
    shippedAt: "2026-10-24T00:45:00Z",
    kind: "feature",
    title: "Done with a post? The next one is one click away",
    body:
      "When you approve a post, send it to review or hand it on from its page, a card in the corner shows " +
      "the next post waiting on you. Click Open next instead of going back to a list.",
    screen: "my-work:next-card",
  },
  {
    id: "2026-10-23-derivatives-assign-all",
    shippedAt: "2026-10-23T20:30:00Z",
    kind: "feature",
    title: "Assign a video's new posts all at once",
    body:
      "When a video's Derivatives tab has posts still at Idea, pick one editor at the top and press Assign: " +
      "they all move to Assigned with that editor, without opening each one.",
    screen: "/[brand]/content/[id]?tab=derivatives",
  },
  {
    id: "2026-10-23-my-work-up-next",
    shippedAt: "2026-10-23T16:05:00Z",
    kind: "feature",
    title: "Go straight to the next post waiting on you",
    body:
      "A post's page now shows \"Up next\" after its status: the next post waiting on you, oldest first. " +
      "Finish this one, click it, and you're on the next, without going back to a list.",
    screen: "/[brand]/content/[id]",
  },
  {
    id: "2026-10-23-my-work-digest",
    shippedAt: "2026-10-23T16:00:00Z",
    kind: "feature",
    title: "A morning email with what's waiting on you",
    body:
      "On weekday mornings you get one email with how many posts are waiting on you and the five to do first: " +
      "send-backs and new comments at the top. No email on days when nothing is waiting, and you can turn it off from My Work.",
    href: "/my-work/email",
    screen: "/my-work/email",
    audience: { flag: "myWorkDigest" },
  },
  {
    id: "2026-10-23-my-work-handoff",
    shippedAt: "2026-10-23T11:30:00Z",
    kind: "feature",
    title: "My Work hands the post to the next person",
    body:
      "The buttons on My Work rows now pass the post along too, like the handoff button on a post's page: " +
      "Send to review goes to the brand's reviewer, and Approve or Send back goes to whoever sent it. The name is on the button.",
    href: "/my-work",
    screen: "/my-work",
  },
  {
    id: "2026-10-23-cross-post-paste",
    shippedAt: "2026-10-23T07:15:00Z",
    kind: "feature",
    title: "Paste cross-post links without leaving the video",
    body:
      "On a post's Cross-post tab, every cross-post that's ready to publish now has its own link box. Post it, paste the live " +
      "link, press Enter: it's marked Published and the cursor jumps to the next one, no trip to each post's page.",
    screen: "/[brand]/content/[id]?tab=cross-post",
  },
  {
    id: "2026-10-22-my-work-news",
    shippedAt: "2026-10-22T23:30:00Z",
    kind: "feature",
    title: "See new comments and send-backs right in My Work",
    body:
      "Each post in My Work now shows the latest comment someone left on it, and \"Sent back by (name)\" when a reviewer " +
      "returned it. A dot marks what's new since you last worked on it, so you can see what needs you without opening every post.",
    href: "/my-work",
    screen: "/my-work",
  },
  {
    id: "2026-10-22-handoff-button",
    shippedAt: "2026-10-22T19:00:00Z",
    kind: "feature",
    title: "Hand a post to your reviewer in one click",
    body:
      "On a post's page, next to its status, a new button does both steps at once: \"Send to review → (name)\" moves your " +
      "post to Review and makes your brand's reviewer its editor. When you review, \"Approve → back to (name)\" marks it Ready To Publish and hands it back.",
    screen: "/[brand]/content/[id]",
  },
  {
    id: "2026-10-22-my-work-row-actions",
    shippedAt: "2026-10-22T14:00:00Z",
    kind: "feature",
    title: "Approve, send back or send to review right from My Work",
    body:
      "Each post in My Work now has its next step as a button: Send to review on your assigned posts, Approve or " +
      "Send back on posts to review (add a note and it lands as a comment for the editor). Or use the keys: j/k to move, r, a, b to act.",
    href: "/my-work",
    screen: "/my-work",
  },
  {
    id: "2026-10-22-my-work-waiting",
    shippedAt: "2026-10-22T09:39:00Z",
    kind: "feature",
    title: "My Work: everything waiting on you, one click away",
    body:
      "The new My Work button at the top of every page shows how many posts are waiting on you: ones assigned to you " +
      "to edit or post, plus a new To review list with the posts in Review on the brands you approve, oldest first.",
    href: "/my-work",
    screen: "/my-work",
  },
  {
    id: "2026-10-22-clip-editor-next-idea",
    shippedAt: "2026-10-22T05:30:00Z",
    kind: "feature",
    title: "Flip through clip ideas without leaving the editor",
    body:
      "Open a clip idea from the Queue and use the arrows next to \"2 of 12\" at the top of the editor to go to " +
      "the previous or next idea (or press [ and ]). No more closing and reopening to compare ideas; your edits still save as you go.",
    href: "/[brand]/queue",
    screen: "modal:clip-editor",
    audience: { flag: "clipEditor" },
  },
  {
    id: "2026-10-22-publish-way-in",
    shippedAt: "2026-10-22T00:54:00Z",
    kind: "feature",
    title: "Just cross-posted? Paste every link on one screen",
    body:
      "After you cross-post a video, its Cross-post tab shows how many posts are ready, with an Open Publish tab " +
      "button. The Publish tab opens with that video's posts on top and the cursor in the first link box: paste, " +
      "Enter, next. The Publish dialog on a post points there too when its sibling posts are waiting.",
    href: "/[brand]/publish",
    screen: "publish:way-in:cross-post-tab",
  },
  {
    id: "2026-10-21-publish-grouped-live",
    shippedAt: "2026-10-21T23:30:00Z",
    kind: "feature",
    title: "Publish: grouped by video, caption copy, live posts spotted",
    body:
      "On the Publish tab, posts now sit under the video they came from, so you can post one video out to every " +
      "platform in one go. Each post has Copy caption and Download media buttons. If a post is already live, " +
      "Hub & Spoke finds it and asks \"That's it?\": one click marks it Published, nothing to paste. " +
      "The Publish tab also shows how many posts are waiting.",
    href: "/[brand]/publish",
    screen: "/[brand]/publish",
  },
  {
    id: "2026-10-21-publish-screen",
    shippedAt: "2026-10-21T20:36:42Z",
    kind: "feature",
    title: "Publish: paste the link, press Enter, next",
    body:
      "The new Publish tab lists every post that's Ready To Publish. Post it, paste the live link on its row " +
      "and press Enter: it's marked Published and you jump to the next one, no need to open each post. " +
      "A link from the wrong platform gets flagged before it's saved.",
    href: "/[brand]/publish",
    screen: "/[brand]/publish",
  },
  {
    id: "2026-10-21-whats-new",
    shippedAt: "2026-10-21T20:00:00Z",
    kind: "feature",
    title: "New improvements, every few days",
    body:
      "Hub & Spoke now ships improvements regularly, shaped by how the team actually uses it. " +
      "When something new lands you'll see it here once. The full list is under your name → What's new.",
  },
];
