import { describe, expect, it } from "vitest";
import {
  NO_REVIEW_LANES,
  reviewLane,
  splitMyWork,
  upNext,
  waitingCount,
  waitingSummary,
  type MyWorkRow,
  type ReviewLanes,
} from "./split";

const ME = "me";
const row = (
  id: string,
  status: string | null,
  brand = "futurepedia",
  editorUserId: string | null = ME,
  format: string | null = "Clip",
): MyWorkRow => ({
  id,
  brand,
  status,
  editorUserId,
  format,
});

/** You approved posts in `mine` lanes; anyone approved posts in `covered`. */
const lanes = (mine: [string, string | null][], covered: [string, string | null][] = []): ReviewLanes => {
  const key = ([brand, format]: [string, string | null]) => reviewLane({ brand, format });
  return {
    mine: new Set(mine.map(key)),
    brands: new Set(mine.map(([b]) => b)),
    covered: new Set([...mine, ...covered].map(key)),
  };
};

describe("splitMyWork", () => {
  it("puts Assigned and Ready To Publish on your turn, the rest waiting", () => {
    const s = splitMyWork(
      [row("a", "Assigned"), row("r", "Ready To Publish"), row("v", "Review"), row("h", "On Hold"), row("n", null)],
      [],
      NO_REVIEW_LANES,
    );
    expect(s.yourTurn.map((r) => r.id)).toEqual(["a", "r"]);
    expect(s.waitingOnOthers.map((r) => r.id)).toEqual(["v", "h"]);
    expect(s.toReview).toEqual([]);
  });

  it("leaves Ideas, no-status and finished items off your plate", () => {
    // Clip-idea generation hands every idea to the pillar's editor; Pat had
    // 2,264 Ideas filling Waiting on others and pushing real work past the limit.
    const s = splitMyWork(
      [row("i", "Idea"), row("n", null), row("p", "Published"), row("k", "Killed"), row("a", "Assigned"), row("h", "On Hold")],
      [],
      NO_REVIEW_LANES,
    );
    expect(s.yourTurn.map((r) => r.id)).toEqual(["a"]);
    expect(s.waitingOnOthers.map((r) => r.id)).toEqual(["h"]);
  });

  it("only offers Review items on brands you approve", () => {
    const s = splitMyWork(
      [],
      [row("x", "Review", "futurepedia", "john"), row("y", "Review", "starter-story", "kate")],
      lanes([["futurepedia", "Clip"]]),
    );
    expect(s.toReview.map((r) => r.id)).toEqual(["x"]);
  });

  it("only offers Review items in formats you approve, not your whole brand", () => {
    // Pat approved one starter-story Business Breakdown; Evgeny approves the
    // Shorts and X posts. Those went back and forth between Noman, Kate and
    // Evgeny, yet filled Pat's morning email as "waiting on you".
    const s = splitMyWork(
      [],
      [
        row("bb", "Review", "starter-story", "noman", "Business Breakdown"),
        row("short", "Review", "starter-story", "noman", "Repackage Section w/ Hook"),
        row("x", "Review", "starter-story", "kate", "A Must Read For X"),
      ],
      lanes(
        [["starter-story", "Business Breakdown"]],
        [
          ["starter-story", "Repackage Section w/ Hook"],
          ["starter-story", "A Must Read For X"],
        ],
      ),
    );
    expect(s.toReview.map((r) => r.id)).toEqual(["bb"]);
  });

  it("offers a format nobody has approved lately to the brand's reviewers", () => {
    const s = splitMyWork(
      [],
      [row("new", "Review", "starter-story", "kate", "Brand New Format")],
      lanes([["starter-story", "Business Breakdown"]]),
    );
    expect(s.toReview.map((r) => r.id)).toEqual(["new"]);
  });

  it("moves your own Review item to To review when you approve that lane, not both", () => {
    const own = row("o", "Review", "my-first-million");
    const s = splitMyWork([own], [own], lanes([["my-first-million", "Clip"]]));
    expect(s.toReview.map((r) => r.id)).toEqual(["o"]);
    expect(s.waitingOnOthers).toEqual([]);
    expect(waitingCount(s)).toBe(1);
  });

  it("counts your turn plus to review, never waiting on others", () => {
    const s = splitMyWork(
      [row("a", "Assigned"), row("h", "On Hold")],
      [row("x", "Review", "futurepedia", "john")],
      lanes([["futurepedia", "Clip"]]),
    );
    expect(s.waitingOnOthers.map((r) => r.id)).toEqual(["h"]);
    expect(waitingCount(s)).toBe(2);
  });
});

describe("upNext", () => {
  const split = {
    // Fetched oldest first.
    toReview: [row("rv-old", "Review"), row("rv-new", "Review")],
    // Fetched newest first.
    yourTurn: [row("t-new", "Assigned"), row("t-old", "Assigned")],
    waitingOnOthers: [row("w", "On Hold")],
  };

  it("offers the oldest post to review first, and never the one you're on", () => {
    expect(upNext(split, null).next?.id).toBe("rv-old");
    expect(upNext(split, "rv-old").next?.id).toBe("rv-new");
  });

  it("then your turn, oldest-touched first; waiting-on-others never counts", () => {
    const yours = { ...split, toReview: [] };
    expect(upNext(yours, null)).toMatchObject({ next: { id: "t-old" }, remaining: 2 });
    expect(upNext(yours, "t-old")).toMatchObject({ next: { id: "t-new" }, remaining: 1 });
  });

  it("is empty when the post you're on was the only one waiting", () => {
    const one = { toReview: [], yourTurn: [row("only", "Assigned")], waitingOnOthers: [] };
    expect(upNext(one, "only")).toEqual({ next: null, remaining: 0, currentWaiting: true, sameSource: false, siblings: [] });
  });

  it("says whether the post you're on is still waiting on you", () => {
    expect(upNext(split, "rv-new").currentWaiting).toBe(true);
    expect(upNext(split, "t-old").currentWaiting).toBe(true);
    // Sent on (approved, sent to review, handed to someone else): off your plate.
    expect(upNext(split, "w").currentWaiting).toBe(false);
    expect(upNext(split, "gone")).toMatchObject({ next: { id: "rv-old" }, remaining: 4, currentWaiting: false });
    expect(upNext(split, null).currentWaiting).toBe(false);
  });

  it("offers the next cross-post of the same post before anything else", () => {
    const xp = (id: string, from: string) => ({ ...row(id, "Ready To Publish"), repostedFromItemId: from });
    const mixed = {
      toReview: [row("rv-old", "Review")],
      // Newest first: the unrelated one is the oldest of all.
      yourTurn: [xp("xp-b", "src"), xp("xp-a", "src"), xp("other", "elsewhere"), row("t-old", "Assigned")],
      waitingOnOthers: [],
    };
    // You just published xp-a (it's gone from the list): xp-b is next, not rv-old.
    const after = upNext(mixed, "xp-a-published", { repostedFromItemId: "src" });
    expect(after).toMatchObject({ next: { id: "xp-a" }, sameSource: true, remaining: 5 });
    expect(upNext(mixed, "xp-a", { repostedFromItemId: "src" })).toMatchObject({ next: { id: "xp-b" }, sameSource: true });
    // Clips of the same video count too.
    const clips = { toReview: [], yourTurn: [{ ...row("c2", "Assigned"), pillarContentItemId: "vid" }, row("t", "Assigned")], waitingOnOthers: [] };
    expect(upNext(clips, "c1", { pillarContentItemId: "vid" })).toMatchObject({ next: { id: "c2" }, sameSource: true });
    // Every cross-post of the same post still waiting, in the order offered.
    expect(after.siblings.map((r) => r.id)).toEqual(["xp-a", "xp-b"]);
    expect(upNext(mixed, "xp-a", { repostedFromItemId: "src" }).siblings.map((r) => r.id)).toEqual(["xp-b"]);
    // No links on the post you're on (or no sibling waiting): the usual order.
    expect(upNext(mixed, "xp-a", { repostedFromItemId: null, pillarContentItemId: null })).toMatchObject({ next: { id: "rv-old" }, sameSource: false });
    expect(upNext(mixed, "xp-a", { repostedFromItemId: "nope" })).toMatchObject({ next: { id: "rv-old" }, sameSource: false, siblings: [] });
  });
});

describe("waitingSummary", () => {
  it("names both queues, reviews first, and leaves out an empty one", () => {
    expect(waitingSummary({ toReview: 2, yourTurn: 3 })).toBe("2 to review · 3 your turn");
    expect(waitingSummary({ toReview: 0, yourTurn: 1 })).toBe("1 your turn");
    expect(waitingSummary({ toReview: 4, yourTurn: 0 })).toBe("4 to review");
    expect(waitingSummary({ toReview: 0, yourTurn: 0 })).toBe("");
  });
});
