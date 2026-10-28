import { describe, it, expect } from "vitest";
import { answerRequest, answersFor, parseAnswer, waited } from "./answer";

const evgeny = { id: "u-evgeny", name: "Evgeny Timofeev" };
const base = { id: "item-1", me: "u-lauren", sentToReviewBy: evgeny, today: "2026-10-28" };

describe("answersFor", () => {
  it("offers all three on a post in Review", () => {
    expect(answersFor("Review", new Set()).map((a) => a.kind)).toEqual(["approve", "posted", "pass"]);
  });

  it("offers nothing once the post has left Review (the email link is stale)", () => {
    expect(answersFor("Ready To Publish", new Set())).toEqual([]);
    expect(answersFor(null, new Set())).toEqual([]);
  });

  it("drops an answer whose status the brand doesn't have", () => {
    const statuses = new Set(["Review", "Published", "Killed"]);
    expect(answersFor("Review", statuses).map((a) => a.kind)).toEqual(["posted", "pass"]);
  });
});

describe("answerRequest", () => {
  const put = (body: Record<string, string>) => ({ url: "/api/production-items", method: "PUT", body });

  it("approve hands the post back to whoever sent it to review", () => {
    expect(answerRequest("approve", base)).toEqual(
      put({ id: "item-1", status: "Ready To Publish", editorUserId: "u-evgeny" }),
    );
  });

  it("approving your own post only moves the status", () => {
    expect(answerRequest("approve", { ...base, me: "u-evgeny" })).toEqual(put({ id: "item-1", status: "Ready To Publish" }));
    expect(answerRequest("approve", { ...base, sentToReviewBy: null })).toEqual(
      put({ id: "item-1", status: "Ready To Publish" }),
    );
  });

  it("already posted goes through the publish route with the link, dated today", () => {
    expect(answerRequest("posted", { ...base, link: "  https://www.instagram.com/reel/abc/ " })).toEqual({
      url: "/api/production-items/item-1/publish",
      method: "POST",
      body: { mode: "publish", link: "https://www.instagram.com/reel/abc/", publishedDate: "2026-10-28" },
    });
  });

  it("already posted waits for a link (Published always has one)", () => {
    expect(answerRequest("posted", { ...base, link: "  " })).toBeNull();
    expect(answerRequest("posted", base)).toBeNull();
  });

  it("not this one kills it with the reason and leaves the editor alone", () => {
    expect(answerRequest("pass", { ...base, reason: " Off-brand for us " })).toEqual(
      put({ id: "item-1", status: "Killed", killReason: "Off-brand for us" }),
    );
  });

  it("not this one waits for a reason the kill rule accepts (10+ characters)", () => {
    expect(answerRequest("pass", base)).toBeNull();
    expect(answerRequest("pass", { ...base, reason: "  nope, no.  " })).toBeNull();
  });
});

describe("parseAnswer / waited", () => {
  it("only knows the three answers", () => {
    expect(parseAnswer("posted")).toBe("posted");
    expect(parseAnswer("delete")).toBeNull();
    expect(parseAnswer(undefined)).toBeNull();
  });

  it("counts whole days, nothing under one", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    expect(waited(new Date("2026-10-28T01:00:00Z"), now)).toBeNull();
    expect(waited(new Date("2026-10-27T11:00:00Z"), now)).toBe("1 day");
    expect(waited(new Date("2026-10-19T12:00:00Z"), now)).toBe("9 days");
  });
});
