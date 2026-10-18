import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisibleInterval } from "./visible-interval";

function fakeDoc() {
  const listeners = new Set<() => void>();
  return {
    hidden: false,
    addEventListener: (_: "visibilitychange", fn: () => void) => listeners.add(fn),
    removeEventListener: (_: "visibilitychange", fn: () => void) => listeners.delete(fn),
    setHidden(h: boolean) {
      this.hidden = h;
      listeners.forEach((fn) => fn());
    },
    listeners,
  };
}

describe("startVisibleInterval", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls on every tick while visible", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    startVisibleInterval(fn, 1000, doc);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("skips ticks while hidden, then catches up once on return", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    startVisibleInterval(fn, 1000, doc);
    doc.setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    doc.setHidden(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not poll on return when no tick was skipped", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    startVisibleInterval(fn, 1000, doc);
    doc.setHidden(true);
    doc.setHidden(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("re-reads a function cadence before every tick", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    let fast = true;
    startVisibleInterval(fn, () => (fast ? 1000 : 10_000), doc);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    fast = false;
    vi.advanceTimersByTime(1000); // the tick already scheduled at 1s
    vi.advanceTimersByTime(9000);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("cleanup stops the timer and the listener", () => {
    const doc = fakeDoc();
    const fn = vi.fn();
    const stop = startVisibleInterval(fn, 1000, doc);
    stop();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    expect(doc.listeners.size).toBe(0);
  });
});
