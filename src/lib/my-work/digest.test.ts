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
      ["t6", { comment: { author: "Andrew", text: "captions?", at }, sentBack: null, isNew: true }],
      ["t7", { comment: null, sentBack: { by: "Sam", at }, isNew: true }],
      ["r1", { comment: { author: "Old", text: "seen", at }, sentBack: null, isNew: false }],
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

  it("escapes titles in the html", () => {
    const d = buildMyWorkDigest({ ...base, yourTurn: [{ ...row("a"), title: "<b>Hi</b> & bye" }], toReview: [] })!;
    expect(d.html).toContain("&lt;b&gt;Hi&lt;/b&gt; &amp; bye");
    expect(d.subject).toBe("1 thing waiting on you — 1 on your turn");
  });
});
