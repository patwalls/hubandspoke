import { describe, expect, it } from "vitest";
import { assignAllIds } from "./assign-all";

const statuses = new Set(["Idea", "Assigned", "Review", "Ready To Publish", "Published"]);

describe("assignAllIds", () => {
  it("picks every row still at Idea, and nothing further along", () => {
    const rows = [
      { id: "a", status: "Idea" },
      { id: "b", status: "Assigned" },
      { id: "c", status: "Idea" },
      { id: "d", status: "Published" },
      { id: "e", status: null },
    ];
    expect(assignAllIds(rows, statuses)).toEqual(["a", "c"]);
  });

  it("stays hidden for a single idea — that's one click already", () => {
    expect(assignAllIds([{ id: "a", status: "Idea" }, { id: "b", status: "Review" }], statuses)).toEqual([]);
  });

  it("stays hidden when the brand has no Assigned status to move them to", () => {
    const rows = [
      { id: "a", status: "Idea" },
      { id: "b", status: "Idea" },
    ];
    expect(assignAllIds(rows, new Set(["Idea", "In Progress"]))).toEqual([]);
  });

  it("counts a post once even if it shows up twice in the merged table", () => {
    const rows = [
      { id: "a", status: "Idea" },
      { id: "a", status: "Idea" },
      { id: "b", status: "Idea" },
    ];
    expect(assignAllIds(rows, statuses)).toEqual(["a", "b"]);
  });
});
