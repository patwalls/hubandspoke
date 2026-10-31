import { describe, it, expect } from "vitest";
import { decodeRun, encodeRun, isTypingTarget, positionInRun, RUN_MAX_AGE_MS, RUN_MAX_ROWS } from "./run";

const now = 1_800_000_000_000;
const rows = [
  { id: "a", title: "First" },
  { id: "b", title: "Second" },
  { id: "c", title: "Third" },
];
const raw = encodeRun({ brand: "starter-story", group: "Review", rows }, now);

describe("the production run remembered for the content page", () => {
  it("names where you are and the posts either side", () => {
    const run = decodeRun(raw, "starter-story", now + 60_000);
    expect(positionInRun(run, "b")).toEqual({
      group: "Review",
      index: 2,
      total: 3,
      prev: rows[0],
      next: rows[2],
    });
  });

  it("has no previous on the first row and no next on the last", () => {
    const run = decodeRun(raw, "starter-story", now);
    expect(positionInRun(run, "a")?.prev).toBeNull();
    expect(positionInRun(run, "c")?.next).toBeNull();
  });

  it("shows nothing on a post that isn't in the run (opened from Content, a link, My Work)", () => {
    expect(positionInRun(decodeRun(raw, "starter-story", now), "zzz")).toBeNull();
  });

  it("shows nothing for a one-row group: there is nowhere to step", () => {
    const one = encodeRun({ brand: "starter-story", group: "Review", rows: [rows[0]] }, now);
    expect(positionInRun(decodeRun(one, "starter-story", now), "a")).toBeNull();
  });

  it("never carries one brand's list onto another brand's post", () => {
    expect(decodeRun(raw, "futurepedia", now)).toBeNull();
  });

  it("forgets the run once stale, so it never steps through rows that have moved", () => {
    expect(decodeRun(raw, "starter-story", now + RUN_MAX_AGE_MS + 1)).toBeNull();
  });

  it("survives junk in storage", () => {
    expect(decodeRun("{not json", "starter-story", now)).toBeNull();
    expect(decodeRun(JSON.stringify({ brand: "starter-story", group: "R", rows: "x", at: now }), "starter-story", now)).toBeNull();
    const mixed = JSON.stringify({ brand: "starter-story", group: "R", rows: [{ id: "a", title: "A" }, { id: 3 }, null], at: now });
    expect(decodeRun(mixed, "starter-story", now)?.rows).toEqual([{ id: "a", title: "A" }]);
  });

  it("caps a huge group (Published) so storage stays small", () => {
    const many = Array.from({ length: RUN_MAX_ROWS + 50 }, (_, i) => ({ id: `id${i}`, title: `T${i}` }));
    const run = decodeRun(encodeRun({ brand: "b", group: "Published", rows: many }, now), "b", now);
    expect(run?.rows).toHaveLength(RUN_MAX_ROWS);
  });
});

describe("j / k only step when you're not typing", () => {
  it("ignores keys typed into fields and rich-text editors", () => {
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", getAttribute: (n) => (n === "role" ? "textbox" : null) })).toBe(true);
  });

  it("steps from the page body or a button", () => {
    expect(isTypingTarget({ tagName: "BODY" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON", getAttribute: () => null })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
