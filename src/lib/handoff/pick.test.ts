import { describe, expect, it } from "vitest";
import { firstName, pickHandoff } from "./pick";

const ME = "me";
const andrew = { id: "andrew", name: "Andrew Gibbs" };
const saj = { id: "saj", name: "Saj Adib" };
const john = { id: "john", name: "John Henry Parr" };
const all = new Set<string>();

describe("pickHandoff", () => {
  it("offers the brand's top reviewer when the item is Assigned", () => {
    const h = pickHandoff({ me: ME, status: "Assigned", editorUserId: ME, brandStatuses: all, reviewers: [andrew, saj], sentToReviewBy: null });
    expect(h).toEqual({ kind: "send-to-review", to: "Review", person: andrew, others: [saj] });
  });

  it("never suggests me as my own reviewer", () => {
    const h = pickHandoff({ me: "andrew", status: "Assigned", editorUserId: "andrew", brandStatuses: all, reviewers: [andrew, saj], sentToReviewBy: null });
    expect(h?.person).toEqual(saj);
    expect(h?.others).toEqual([]);
  });

  it("offers nothing on someone else's Assigned item", () => {
    expect(pickHandoff({ me: ME, status: "Assigned", editorUserId: "john", brandStatuses: all, reviewers: [andrew], sentToReviewBy: null })).toBeNull();
  });

  it("offers nothing when the brand has no other reviewer", () => {
    expect(pickHandoff({ me: ME, status: "Assigned", editorUserId: ME, brandStatuses: all, reviewers: [{ id: ME, name: "Me" }], sentToReviewBy: null })).toBeNull();
  });

  it("offers nothing when the brand has no Review status", () => {
    const statuses = new Set(["Assigned", "Ready To Publish"]);
    expect(pickHandoff({ me: ME, status: "Assigned", editorUserId: ME, brandStatuses: statuses, reviewers: [andrew], sentToReviewBy: null })).toBeNull();
  });

  it("hands an approved item back to whoever sent it to review", () => {
    const h = pickHandoff({ me: "andrew", status: "Review", editorUserId: "andrew", brandStatuses: all, reviewers: [andrew], sentToReviewBy: john });
    expect(h).toEqual({ kind: "approve", to: "Ready To Publish", person: john, others: [] });
  });

  it("still offers Approve when the editor is already the sender (set back by hand first)", () => {
    const h = pickHandoff({ me: "andrew", status: "Review", editorUserId: "john", brandStatuses: all, reviewers: [], sentToReviewBy: john });
    expect(h).toEqual({ kind: "approve", to: "Ready To Publish", person: john, others: [] });
  });

  it("offers nothing on a post I sent to review myself", () => {
    expect(pickHandoff({ me: "john", status: "Review", editorUserId: "andrew", brandStatuses: all, reviewers: [], sentToReviewBy: john })).toBeNull();
    expect(pickHandoff({ me: "john", status: "Review", editorUserId: "john", brandStatuses: all, reviewers: [], sentToReviewBy: john })).toBeNull();
  });

  it("offers nothing in Review without a known sender, or in other statuses", () => {
    expect(pickHandoff({ me: ME, status: "Review", editorUserId: "andrew", brandStatuses: all, reviewers: [andrew], sentToReviewBy: null })).toBeNull();
    expect(pickHandoff({ me: ME, status: "Ready To Publish", editorUserId: ME, brandStatuses: all, reviewers: [andrew], sentToReviewBy: john })).toBeNull();
  });
});

describe("firstName", () => {
  it("takes the first word", () => {
    expect(firstName("John Henry Parr")).toBe("John");
    expect(firstName("Nuriel")).toBe("Nuriel");
  });
});
