import { describe, expect, it } from "vitest";
import { composerHandoffLabel, firstName, isHandoffNoteRecipient, nextCardHandoff, pickHandoff } from "./pick";

const ME = "me";
const andrew = { id: "andrew", name: "Andrew Gibbs" };
const saj = { id: "saj", name: "Saj Adib" };
const john = { id: "john", name: "John Henry Parr" };
const all = new Set<string>();

describe("pickHandoff", () => {
  const noman = { id: "noman", name: "Noman Bhagad" };
  const base = { me: ME, brandStatuses: all, reviewers: [andrew], sentToReviewBy: null };

  it("offers to assign an unstarted post to whoever makes its format", () => {
    for (const status of ["Idea", "Ready To Publish"]) {
      const h = pickHandoff({ ...base, status, editorUserId: null, formatEditors: [noman, john] });
      expect(h).toEqual({ kind: "assign", to: "Assigned", person: noman, others: [john] });
    }
  });

  it("offers assign when I picked it up myself first (the curator self-assigns)", () => {
    const h = pickHandoff({ ...base, status: "Ready To Publish", editorUserId: ME, formatEditors: [noman] });
    expect(h?.kind).toBe("assign");
    expect(h?.person).toEqual(noman);
  });

  it("never offers to assign to me, or over someone else holding it", () => {
    expect(pickHandoff({ ...base, status: "Idea", editorUserId: null, formatEditors: [{ id: ME, name: "Me" }] })).toBeNull();
    expect(pickHandoff({ ...base, status: "Idea", editorUserId: "john", formatEditors: [noman] })).toBeNull();
  });

  it("offers no assign without format history, on started/finished posts, or without an Assigned status", () => {
    expect(pickHandoff({ ...base, status: "Idea", editorUserId: null })).toBeNull();
    for (const status of ["Published", "Scheduled", "Killed"]) {
      expect(pickHandoff({ ...base, status, editorUserId: null, formatEditors: [noman] })).toBeNull();
    }
    const noAssigned = new Set(["Idea", "Ready To Publish", "Published"]);
    expect(pickHandoff({ ...base, brandStatuses: noAssigned, status: "Idea", editorUserId: null, formatEditors: [noman] })).toBeNull();
  });

  it("an Assigned post still offers send-to-review, not assign", () => {
    const h = pickHandoff({ ...base, status: "Assigned", editorUserId: ME, formatEditors: [noman] });
    expect(h?.kind).toBe("send-to-review");
  });

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

  it("names the reviewer on a post I moved to Review from the status menu and still hold", () => {
    const h = pickHandoff({ me: ME, status: "Review", editorUserId: ME, brandStatuses: all, reviewers: [andrew, saj], sentToReviewBy: { id: ME, name: "Me" } });
    expect(h).toEqual({ kind: "name-reviewer", to: "Review", person: andrew, others: [saj] });
  });

  it("names the reviewer on a post in Review I hold with no known sender", () => {
    const h = pickHandoff({ me: ME, status: "Review", editorUserId: ME, brandStatuses: all, reviewers: [{ id: ME, name: "Me" }, andrew], sentToReviewBy: null });
    expect(h).toEqual({ kind: "name-reviewer", to: "Review", person: andrew, others: [] });
  });

  it("offers nothing on a post in Review someone else holds that I sent", () => {
    expect(pickHandoff({ me: ME, status: "Review", editorUserId: "andrew", brandStatuses: all, reviewers: [andrew, saj], sentToReviewBy: { id: ME, name: "Me" } })).toBeNull();
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

describe("composerHandoffLabel", () => {
  it("labels the box's assign with the editor's first name", () => {
    expect(composerHandoffLabel({ kind: "assign", to: "Assigned", person: john, others: [] })).toBe("Comment & assign → John");
  });

  it("names the reviewer for send-to-review and name-reviewer", () => {
    expect(composerHandoffLabel({ kind: "send-to-review", to: "Review", person: andrew, others: [] })).toBe(
      "Comment & send to review → Andrew",
    );
    expect(composerHandoffLabel({ kind: "name-reviewer", to: "Review", person: andrew, others: [] })).toBe(
      "Comment & hand to Andrew",
    );
  });

  it("offers nothing for approve (that stays on the status chip) or no handoff", () => {
    expect(composerHandoffLabel({ kind: "approve", to: "Ready To Publish", person: john, others: [] })).toBeNull();
    expect(composerHandoffLabel(null)).toBeNull();
  });
});

describe("isHandoffNoteRecipient", () => {
  it("mutes only the person the post was just handed to", () => {
    expect(isHandoffNoteRecipient("andrew", "andrew", "andrew")).toBe(true);
    expect(isHandoffNoteRecipient("andrew", "andrew", "saj")).toBe(false);
  });

  it("ignores a handoffTo that isn't the post's editor (the handoff didn't save)", () => {
    expect(isHandoffNoteRecipient("andrew", ME, "andrew")).toBe(false);
    expect(isHandoffNoteRecipient(null, "andrew", "andrew")).toBe(false);
  });
});

describe("nextCardHandoff", () => {
  const rita = { id: "r", name: "Rita Reviewer" };
  const base = { to: "Review", person: rita, others: [] };
  it("offers the reviewer only when the post is in Review but still yours", () => {
    expect(nextCardHandoff({ ...base, kind: "name-reviewer" })).toEqual(rita);
  });
  it("offers nothing for a send-to-review, an approve, or no handoff", () => {
    expect(nextCardHandoff({ ...base, kind: "send-to-review" })).toBeNull();
    expect(nextCardHandoff({ ...base, kind: "approve", to: "Ready To Publish" })).toBeNull();
    expect(nextCardHandoff(null)).toBeNull();
  });
});
