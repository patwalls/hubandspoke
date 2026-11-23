import { describe, expect, it } from "vitest";
import { autoCloseCutoff, autoCloseDisabled, autoCloseRunId, AUTO_CLOSE_DAYS } from "./idea-auto-close";

describe("idea auto-close helpers", () => {
  it("names a run by its UTC date", () => {
    expect(autoCloseRunId(Date.parse("2026-11-30T11:00:03Z"))).toBe("2026-11-30");
  });

  it("cuts off at 60 days", () => {
    const now = Date.parse("2026-11-30T11:00:00Z");
    expect(AUTO_CLOSE_DAYS).toBe(60);
    expect(autoCloseCutoff(now).toISOString()).toBe("2026-10-01T11:00:00.000Z");
  });

  it("is on unless IDEA_AUTO_CLOSE says off", () => {
    expect(autoCloseDisabled({})).toBe(false);
    expect(autoCloseDisabled({ IDEA_AUTO_CLOSE: "on" })).toBe(false);
    for (const v of ["off", "OFF", "0", "false"]) expect(autoCloseDisabled({ IDEA_AUTO_CLOSE: v })).toBe(true);
  });
});
