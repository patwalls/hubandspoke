import { describe, it, expect } from "vitest";
import { buildMyWorkDigest, type DigestRow } from "./digest";
import type { RowNews } from "./news";

const row = (id: string, status = "Assigned"): DigestRow => ({
  id,
  title: `Post ${id}`,
  brand: "starter-story",
  status,
});
const base = { firstName: "Kate", baseUrl: "https://hs.test", news: new Map<string, RowNews>() };

describe("buildMyWorkDigest", () => {
  it("sends nothing when nothing is waiting", () => {
    expect(buildMyWorkDigest({ ...base, yourTurn: [], toReview: [] })).toBeNull();
  });

  it("leads the subject with the count, split by kind", () => {
    const d = buildMyWorkDigest({ ...base, yourTurn: [row("a")], toReview: [row("b", "Review"), row("c", "Review")] })!;
    expect(d.subject).toBe("3 things waiting on you — 1 on your turn, 2 to review");
    expect(d.text).toContain("https://hs.test/my-work");
    expect(d.html).toContain("https://hs.test/starter-story/content/a");
  });

  it("puts send-backs, then new comments, ahead of the rest; caps at five", () => {
    const at = new Date();
    const news = new Map<string, RowNews>([
      ["t6", { comment: { author: "Andrew", text: "captions?", at }, sentBack: null, handedBy: null, isNew: true }],
      ["t7", { comment: null, sentBack: { by: "Sam", at }, handedBy: null, isNew: true }],
      ["r1", { comment: { author: "Old", text: "seen", at }, sentBack: null, handedBy: null, isNew: false }],
    ]);
    const yourTurn = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"].map((id) => row(id));
    const d = buildMyWorkDigest({ ...base, news, yourTurn, toReview: [row("r1", "Review")] })!;
    expect(d.top.map((t) => t.row.id)).toEqual(["t7", "t6", "r1", "t1", "t2"]);
    expect(d.top.map((t) => t.why).slice(0, 3)).toEqual([
      "Sent back by Sam",
      "New comment from Andrew",
      "To review",
    ]);
    expect(d.text).toContain("…and 3 more.");
  });

  it("says who handed a new post to you", () => {
    const news = new Map<string, RowNews>([
      ["a", { comment: null, sentBack: null, handedBy: { by: "Evgeny", at: new Date() }, isNew: true }],
    ]);
    const d = buildMyWorkDigest({ ...base, news, yourTurn: [row("z"), row("a")], toReview: [] })!;
    expect(d.top[0]).toMatchObject({ row: { id: "a" }, why: "Handed to you by Evgeny" });
  });

  it("names each line's platform, so same-titled cross-posts read apart", () => {
    const d = buildMyWorkDigest({
      ...base,
      yourTurn: [
        { ...row("a"), title: "Same post", postType: "instagram_reel" },
        { ...row("b"), title: "Same post", postType: "tiktok" },
        { ...row("c"), title: "No type" },
      ],
      toReview: [],
    })!;
    expect(d.text).toContain("- Same post (starter-story · Instagram Reel) — Assigned");
    expect(d.text).toContain("- Same post (starter-story · TikTok) — Assigned");
    expect(d.text).toContain("- No type (starter-story) — Assigned");
    expect(d.html).toContain("starter-story · Instagram Reel · Assigned");
    expect(d.html).toContain("starter-story · TikTok · Assigned");
  });

  it("escapes titles in the html", () => {
    const d = buildMyWorkDigest({ ...base, yourTurn: [{ ...row("a"), title: "<b>Hi</b> & bye" }], toReview: [] })!;
    expect(d.html).toContain("&lt;b&gt;Hi&lt;/b&gt; &amp; bye");
    expect(d.subject).toBe("1 thing waiting on you — 1 on your turn");
  });
  it("gives To review lines their wait and the three answers, and names the oldest", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    const reviewSince = new Map([
      ["old", new Date("2026-10-19T12:00:00Z")],
      ["new", new Date("2026-10-28T09:00:00Z")],
    ]);
    const d = buildMyWorkDigest({
      ...base,
      now,
      reviewSince,
      yourTurn: [row("t1")],
      toReview: [row("old", "Review"), row("new", "Review")],
    })!;
    expect(d.subject).toBe("3 things waiting on you — 1 on your turn, 2 to review (oldest 9 days)");
    expect(d.top.map((t) => [t.row.id, t.why, t.answerable])).toEqual([
      ["old", "To review, waiting 9 days", true],
      ["new", "To review", true],
      ["t1", "Assigned", false],
    ]);
    for (const a of ["approve", "posted", "pass"]) {
      expect(d.html).toContain(`https://hs.test/my-work/answer/old?a=${a}`);
      expect(d.text).toContain(`https://hs.test/my-work/answer/old?a=${a}`);
    }
    // Your-turn lines don't get answer links.
    expect(d.html).not.toContain("/my-work/answer/t1");
  });
});
