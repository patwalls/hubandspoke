import { describe, it, expect } from "vitest";
import { parseNaturalTime } from "./parse-natural-time";

// Fixed reference: Thursday, 2026-06-25 14:00 local.
const NOW = new Date(2026, 5, 25, 14, 0, 0, 0);

function rel(input: string): number | null {
  const d = parseNaturalTime(input, NOW);
  return d ? Math.round((d.getTime() - NOW.getTime()) / 60000) : null;
}

describe("parseNaturalTime", () => {
  it("parses relative hours (word + digit, with/without 'in')", () => {
    expect(rel("in two hours")).toBe(120);
    expect(rel("in 2 hours")).toBe(120);
    expect(rel("2h")).toBe(120);
    expect(rel("in 1 hour")).toBe(60);
  });

  it("parses relative minutes / days / weeks", () => {
    expect(rel("in 90 minutes")).toBe(90);
    expect(rel("in 30 min")).toBe(30);
    expect(rel("in 1 day")).toBe(24 * 60);
    expect(rel("in 1 week")).toBe(7 * 24 * 60);
  });

  it("parses 'tomorrow' with default 9am and explicit time", () => {
    const def = parseNaturalTime("tomorrow", NOW)!;
    expect(def.getDate()).toBe(26);
    expect(def.getHours()).toBe(9);
    const at = parseNaturalTime("tomorrow 5pm", NOW)!;
    expect(at.getDate()).toBe(26);
    expect(at.getHours()).toBe(17);
  });

  it("parses bare clock times and rolls past times to tomorrow", () => {
    const future = parseNaturalTime("9pm", NOW)!; // 21:00 today
    expect(future.getDate()).toBe(25);
    expect(future.getHours()).toBe(21);
    const past = parseNaturalTime("9am", NOW)!; // already past 14:00 → tomorrow
    expect(past.getDate()).toBe(26);
    expect(past.getHours()).toBe(9);
  });

  it("parses noon / midnight / tonight", () => {
    expect(parseNaturalTime("noon", NOW)!.getHours()).toBe(12); // rolls tomorrow (past)
    expect(parseNaturalTime("tonight", NOW)!.getHours()).toBe(20);
    const mid = parseNaturalTime("midnight", NOW)!;
    expect(mid.getHours()).toBe(0);
    expect(mid.getDate()).toBe(26);
  });

  it("parses 24h and :30 times", () => {
    const t = parseNaturalTime("21:30", NOW)!;
    expect(t.getHours()).toBe(21);
    expect(t.getMinutes()).toBe(30);
  });

  it("returns null for gibberish / empty", () => {
    expect(parseNaturalTime("", NOW)).toBeNull();
    expect(parseNaturalTime("whenever", NOW)).toBeNull();
    expect(parseNaturalTime("in a bit", NOW)).toBeNull();
  });
});
