import { describe, expect, it } from "vitest";
import { clearOlderCutoff, parseClearOlderRequest } from "./queue-clear-older";

describe("parseClearOlderRequest", () => {
  it("refuses /all and a missing brand — a clear is always one brand", () => {
    expect(parseClearOlderRequest({ brand: "all", dryRun: true }).ok).toBe(false);
    expect(parseClearOlderRequest({ dryRun: true }).ok).toBe(false);
    expect(parseClearOlderRequest(null).ok).toBe(false);
  });

  it("a dry run needs no reason; a real clear needs 10+ characters", () => {
    expect(parseClearOlderRequest({ brand: "mfm", dryRun: true })).toEqual({
      ok: true,
      value: { brand: "mfm", format: null, dryRun: true, reason: null },
    });
    expect(parseClearOlderRequest({ brand: "mfm", reason: "too old" }).ok).toBe(false);
    // dryRun must be literally true — a truthy string doesn't skip the reason check.
    expect(parseClearOlderRequest({ brand: "mfm", dryRun: "yes" }).ok).toBe(false);
    const ok = parseClearOlderRequest({ brand: "mfm", reason: "  untouched for months  " });
    expect(ok).toEqual({
      ok: true,
      value: { brand: "mfm", format: null, dryRun: false, reason: "untouched for months" },
    });
  });

  it("'all' or blank format means every format", () => {
    const all = parseClearOlderRequest({ brand: "mfm", format: "all", dryRun: true });
    expect(all.ok && all.value.format).toBe(null);
    const one = parseClearOlderRequest({ brand: "mfm", format: " Shorts Clip ", dryRun: true });
    expect(one.ok && one.value.format).toBe("Shorts Clip");
  });

  it("caps the reason at 2000 characters", () => {
    const r = parseClearOlderRequest({ brand: "mfm", reason: "x".repeat(3000) });
    expect(r.ok && r.value.reason?.length).toBe(2000);
  });
});

describe("clearOlderCutoff", () => {
  it("is 30 days before now", () => {
    const now = Date.parse("2026-11-22T00:00:00Z");
    expect(clearOlderCutoff(now).toISOString()).toBe("2026-10-23T00:00:00.000Z");
  });
});
