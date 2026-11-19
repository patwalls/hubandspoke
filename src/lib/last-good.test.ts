import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLastGood } from "./last-good";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLastGood", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the first value when nothing is remembered", async () => {
    const lg = createLastGood<string>({ waitMs: 100, maxStaleMs: 60_000 });
    const d = deferred<string>();
    const p = lg.get("k", () => d.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    d.resolve("first");
    await expect(p).resolves.toEqual({ value: "first", stale: false, ageMs: 0 });
  });

  it("serves the remembered value when a rebuild is slow, then remembers the new one", async () => {
    const lg = createLastGood<string>({ waitMs: 100, maxStaleMs: 60_000 });
    await lg.get("k", async () => "v1");

    const d = deferred<string>();
    const p = lg.get("k", () => d.promise);
    await vi.advanceTimersByTimeAsync(100);
    const served = await p;
    expect(served.value).toBe("v1");
    expect(served.stale).toBe(true);

    // The slow rebuild keeps going and lands for the next caller.
    d.resolve("v2");
    await vi.advanceTimersByTimeAsync(0);
    const next = await lg.get("k", async () => "v3");
    expect(next).toEqual({ value: "v3", stale: false, ageMs: 0 });
  });

  it("returns the fresh value when the rebuild is quick", async () => {
    const lg = createLastGood<string>({ waitMs: 100, maxStaleMs: 60_000 });
    await lg.get("k", async () => "v1");
    await expect(lg.get("k", async () => "v2")).resolves.toEqual({
      value: "v2",
      stale: false,
      ageMs: 0,
    });
  });

  it("shares one rebuild between callers asking at the same time", async () => {
    const lg = createLastGood<string>({ waitMs: 100, maxStaleMs: 60_000 });
    const compute = vi.fn(() => new Promise<string>((r) => setTimeout(() => r("v"), 50)));
    const both = Promise.all([lg.get("k", compute), lg.get("k", compute)]);
    await vi.advanceTimersByTimeAsync(50);
    await both;
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("doesn't serve a value older than maxStaleMs", async () => {
    let t = 0;
    const lg = createLastGood<string>({ waitMs: 100, maxStaleMs: 1_000, now: () => t });
    await lg.get("k", async () => "old");
    t = 5_000;
    const d = deferred<string>();
    const p = lg.get("k", () => d.promise);
    await vi.advanceTimersByTimeAsync(500);
    d.resolve("new");
    await expect(p).resolves.toEqual({ value: "new", stale: false, ageMs: 0 });
  });

  it("serves the remembered value when the rebuild fails", async () => {
    const lg = createLastGood<string>({ waitMs: 100, maxStaleMs: 60_000 });
    await lg.get("k", async () => "v1");
    const served = await lg.get("k", async () => {
      throw new Error("db down");
    });
    expect(served).toMatchObject({ value: "v1", stale: true });
  });

  it("throws when nothing is remembered and the build fails", async () => {
    const lg = createLastGood<string>({ waitMs: 100, maxStaleMs: 60_000 });
    await expect(
      lg.get("k", async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
  });
});

describe("createLastGood.fresh", () => {
  it("waits for the rebuild and makes it the remembered value", async () => {
    vi.useFakeTimers();
    const lg = createLastGood<string>({ waitMs: 100, maxStaleMs: 60_000 });
    await expect(lg.fresh("k", async () => "warmed")).resolves.toBe("warmed");
    const d = deferred<string>();
    const p = lg.get("k", () => d.promise);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toMatchObject({ value: "warmed", stale: true });
    d.resolve("later");
    vi.useRealTimers();
  });
});
