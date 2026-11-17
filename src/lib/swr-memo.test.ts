import { describe, it, expect, vi } from "vitest";
import { createSwrMemo } from "./swr-memo";

// The In Production report's slow inputs (view history, format odds) are
// memoized with this; a cold report after an edit must not wait on them.
describe("createSwrMemo", () => {
  function setup() {
    let t = 0;
    const memo = createSwrMemo<number>({ freshMs: 1_000, maxStaleMs: 10_000, now: () => t });
    return { memo, advance: (ms: number) => (t += ms) };
  }

  it("callers asking at once share one computation", async () => {
    const { memo } = setup();
    const compute = vi.fn(async () => 1);
    const [a, b] = await Promise.all([memo.get("k", compute), memo.get("k", compute)]);
    expect([a, b]).toEqual([1, 1]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("a fresh value is reused without recomputing", async () => {
    const { memo, advance } = setup();
    const compute = vi.fn(async () => 1);
    await memo.get("k", compute);
    advance(999);
    await memo.get("k", compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("a stale value is served at once while one refresh runs behind it", async () => {
    const { memo, advance } = setup();
    await memo.get("k", async () => 1);
    advance(5_000);
    let release!: (v: number) => void;
    const slow = vi.fn(() => new Promise<number>((r) => (release = r)));
    // Served instantly from the old value, even though the refresh hangs.
    expect(await memo.get("k", slow)).toBe(1);
    expect(await memo.get("k", slow)).toBe(1);
    expect(slow).toHaveBeenCalledTimes(1);
    release(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(await memo.get("k", slow)).toBe(2);
  });

  it("a failed background refresh keeps the old value", async () => {
    const { memo, advance } = setup();
    await memo.get("k", async () => 1);
    advance(5_000);
    expect(await memo.get("k", async () => Promise.reject(new Error("db down")))).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(await memo.get("k", async () => Promise.reject(new Error("db down")))).toBe(1);
  });

  it("past maxStale the caller waits for a new value", async () => {
    const { memo, advance } = setup();
    await memo.get("k", async () => 1);
    advance(10_000);
    expect(await memo.get("k", async () => 2)).toBe(2);
  });

  it("keys are separate", async () => {
    const { memo } = setup();
    expect(await memo.get("a", async () => 1)).toBe(1);
    expect(await memo.get("b", async () => 2)).toBe(2);
  });
});
