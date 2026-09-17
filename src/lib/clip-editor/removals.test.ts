import { describe, it, expect } from "vitest";
import type { Section } from "./doc";
import {
  addRemoval,
  keptRanges,
  restoreRange,
  restoreReason,
  retimeSection,
} from "./removals";

const section = (removals: Section["removals"] = []): Section => ({
  id: "body",
  role: "body",
  startSec: 10,
  endSec: 20,
  removals,
});

describe("addRemoval", () => {
  it("merges overlapping removals that share a reason", () => {
    let s = addRemoval(section(), { startSec: 12, endSec: 13 }, "manual");
    s = addRemoval(s, { startSec: 12.5, endSec: 14 }, "manual");
    expect(s.removals).toEqual([{ startSec: 12, endSec: 14, reason: "manual" }]);
  });

  it("keeps different reasons separate so bulk restore stays possible", () => {
    let s = addRemoval(section(), { startSec: 12, endSec: 13 }, "filler");
    s = addRemoval(s, { startSec: 13, endSec: 14 }, "manual");
    expect(s.removals.map((r) => r.reason)).toEqual(["filler", "manual"]);
    expect(restoreReason(s, "filler").removals).toEqual([
      { startSec: 13, endSec: 14, reason: "manual" },
    ]);
  });

  it("a new removal wins over the part of an older one it overlaps", () => {
    let s = addRemoval(section(), { startSec: 12, endSec: 16 }, "silence");
    s = addRemoval(s, { startSec: 13, endSec: 14 }, "manual");
    expect(s.removals).toEqual([
      { startSec: 12, endSec: 13, reason: "silence" },
      { startSec: 13, endSec: 14, reason: "manual" },
      { startSec: 14, endSec: 16, reason: "silence" },
    ]);
  });

  it("clamps to the section window", () => {
    const s = addRemoval(section(), { startSec: 5, endSec: 11 }, "manual");
    expect(s.removals).toEqual([{ startSec: 10, endSec: 11, reason: "manual" }]);
  });
});

describe("restoreRange", () => {
  it("splits a removal when the middle of it is restored", () => {
    const s = restoreRange(
      section([{ startSec: 12, endSec: 16, reason: "manual" }]),
      { startSec: 13, endSec: 14 },
    );
    expect(s.removals).toEqual([
      { startSec: 12, endSec: 13, reason: "manual" },
      { startSec: 14, endSec: 16, reason: "manual" },
    ]);
  });
});

describe("keptRanges", () => {
  it("is the window minus the removals", () => {
    expect(
      keptRanges(
        section([
          { startSec: 10, endSec: 11, reason: "manual" },
          { startSec: 15, endSec: 16, reason: "filler" },
        ]),
      ),
    ).toEqual([
      { startSec: 11, endSec: 15 },
      { startSec: 16, endSec: 20 },
    ]);
  });

  it("is empty when everything was removed", () => {
    expect(
      keptRanges(section([{ startSec: 10, endSec: 20, reason: "manual" }])),
    ).toEqual([]);
  });
});

describe("retimeSection", () => {
  it("re-clamps removals to the new window and drops ones that fall outside", () => {
    const s = retimeSection(
      section([
        { startSec: 10.5, endSec: 11, reason: "manual" },
        { startSec: 14, endSec: 18, reason: "manual" },
      ]),
      { startSec: 12, endSec: 16 },
    );
    expect(s.startSec).toBe(12);
    expect(s.removals).toEqual([{ startSec: 14, endSec: 16, reason: "manual" }]);
  });

  it("ignores an inverted window instead of corrupting the section", () => {
    const original = section();
    expect(retimeSection(original, { startSec: 16, endSec: 12 })).toBe(original);
  });
});
