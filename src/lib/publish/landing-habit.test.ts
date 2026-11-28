import { describe, expect, it } from "vitest";
import {
  EMPTY_HABIT,
  decodeHabit,
  listHref,
  onBounce,
  onLanding,
  optOut,
  prefersList,
  type Habit,
} from "./landing-habit";

function run(steps: Array<"land" | "bounce">, from: Habit = EMPTY_HABIT): Habit {
  return steps.reduce((h, s) => (s === "land" ? onLanding(h) : onBounce(h)), from);
}

describe("landing habit", () => {
  it("learns the list after two bounces in a row", () => {
    expect(prefersList(run(["land", "bounce"]))).toBe(false);
    expect(prefersList(run(["land", "bounce", "land", "bounce"]))).toBe(true);
  });

  it("a landing they stayed on resets the count", () => {
    // land, bounce, land (stayed: no bounce), land, bounce → 1 in a row
    const h = run(["land", "bounce", "land", "land", "bounce"]);
    expect(h.bounces).toBe(1);
    expect(prefersList(h)).toBe(false);
  });

  it("a trip to the list with no landing before it counts nothing", () => {
    expect(run(["bounce", "bounce", "bounce"]).bounces).toBe(0);
    // Two list opens after one landing are one bounce.
    expect(run(["land", "bounce", "bounce"]).bounces).toBe(1);
  });

  it("someone who always stays on the post never learns it", () => {
    expect(prefersList(run(["land", "land", "land", "land"]))).toBe(false);
  });

  it("opting out sticks, whatever happens after", () => {
    const h = run(["land", "bounce", "land", "bounce", "land", "bounce"], optOut());
    expect(prefersList(h)).toBe(false);
    expect(decodeHabit(JSON.stringify(h)).optedOut).toBe(true);
  });

  it("decodes junk as a fresh habit", () => {
    expect(decodeHabit(null)).toEqual(EMPTY_HABIT);
    expect(decodeHabit("{oops")).toEqual(EMPTY_HABIT);
    expect(decodeHabit(JSON.stringify({ bounces: -3, pending: "yes" }))).toEqual(EMPTY_HABIT);
    expect(decodeHabit(JSON.stringify({ bounces: 2, pending: true }))).toEqual({ bounces: 2, pending: true });
  });
});

describe("listHref", () => {
  it("keeps the filtered list this tab had open for that brand", () => {
    expect(listHref("matg", "/matg/production?editor=me")).toBe("/matg/production?editor=me");
  });
  it("falls back to the bare list for another brand's list or junk", () => {
    expect(listHref("matg", "/starter-story/production?editor=me")).toBe("/matg/production");
    expect(listHref("matg", null)).toBe("/matg/production");
    expect(listHref("matg", "//evil.example/matg/production")).toBe("/matg/production");
  });
});
