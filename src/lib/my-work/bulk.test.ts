import { describe, expect, it } from "vitest";
import { bulkMoveTargets, inBatches } from "./bulk";

const statuses = {
  "starter-story": ["Idea", "Outreach", "Assigned", "Review", "On Hold", "Scheduled", "Published", "Killed"],
  futurepedia: ["Idea", "Assigned", "Review", "Ready To Publish", "On Hold", "Scheduled", "Published", "Killed"],
};

describe("bulkMoveTargets", () => {
  it("offers only statuses every selected brand has, in the first brand's order", () => {
    expect(bulkMoveTargets(["starter-story", "futurepedia", "starter-story"], statuses)).toEqual([
      "Idea",
      "Assigned",
      "Review",
      "On Hold",
    ]);
  });

  it("never offers Published, Scheduled or Killed (publish route / kill reason)", () => {
    const t = bulkMoveTargets(["futurepedia"], statuses);
    expect(t).toContain("Ready To Publish");
    expect(t).not.toContain("Published");
    expect(t).not.toContain("Scheduled");
    expect(t).not.toContain("Killed");
  });

  it("offers nothing for an empty selection or an unknown brand", () => {
    expect(bulkMoveTargets([], statuses)).toEqual([]);
    expect(bulkMoveTargets(["futurepedia", "nope"], statuses)).toEqual([]);
  });
});

describe("inBatches", () => {
  it("never runs more than `size` at once and counts failures", async () => {
    let running = 0;
    let peak = 0;
    const res = await inBatches([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      if (n % 3 === 0) throw new Error(`bad ${n}`);
    });
    expect(peak).toBe(3);
    expect(res).toEqual({ ok: 5, failed: 2, firstError: "bad 3" });
  });
});
