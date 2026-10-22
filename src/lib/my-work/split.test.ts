import { describe, expect, it } from "vitest";
import { splitMyWork, waitingCount, type MyWorkRow } from "./split";

const ME = "me";
const row = (id: string, status: string | null, brand = "futurepedia", editorUserId: string | null = ME): MyWorkRow => ({
  id,
  brand,
  status,
  editorUserId,
});

describe("splitMyWork", () => {
  it("puts Assigned and Ready To Publish on your turn, the rest waiting", () => {
    const s = splitMyWork(
      [row("a", "Assigned"), row("r", "Ready To Publish"), row("v", "Review"), row("h", "On Hold"), row("n", null)],
      [],
      new Set(),
    );
    expect(s.yourTurn.map((r) => r.id)).toEqual(["a", "r"]);
    expect(s.waitingOnOthers.map((r) => r.id)).toEqual(["v", "h", "n"]);
    expect(s.toReview).toEqual([]);
  });

  it("only offers Review items on brands you approve", () => {
    const s = splitMyWork(
      [],
      [row("x", "Review", "futurepedia", "john"), row("y", "Review", "starter-story", "kate")],
      new Set(["futurepedia"]),
    );
    expect(s.toReview.map((r) => r.id)).toEqual(["x"]);
  });

  it("moves your own Review item to To review when you approve that brand, not both", () => {
    const own = row("o", "Review", "my-first-million");
    const s = splitMyWork([own], [own], new Set(["my-first-million"]));
    expect(s.toReview.map((r) => r.id)).toEqual(["o"]);
    expect(s.waitingOnOthers).toEqual([]);
    expect(waitingCount(s)).toBe(1);
  });

  it("counts your turn plus to review, never waiting on others", () => {
    const s = splitMyWork(
      [row("a", "Assigned"), row("h", "On Hold")],
      [row("x", "Review", "futurepedia", "john")],
      new Set(["futurepedia"]),
    );
    expect(s.waitingOnOthers.map((r) => r.id)).toEqual(["h"]);
    expect(waitingCount(s)).toBe(2);
  });
});
