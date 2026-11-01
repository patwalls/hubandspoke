import { describe, it, expect } from "vitest";
import {
  saveReturnSpot,
  takeReturnSpot,
  opensInThisTab,
  RETURN_SPOT_TTL_MS,
} from "./return-spot";

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
}

const href = "/starter-story/content?platform=youtube";
const spot = { id: "item-1", y: 1840, href, at: 1_000_000 };

describe("return spot", () => {
  it("comes back once for the same list", () => {
    const s = memoryStore();
    saveReturnSpot(s, "starter-story", spot);
    expect(takeReturnSpot(s, "starter-story", href, spot.at + 5_000)).toEqual(spot);
    // One return only — a second visit lands normally.
    expect(takeReturnSpot(s, "starter-story", href, spot.at + 6_000)).toBeNull();
  });

  it("ignores a different filter (a different list) and forgets the spot", () => {
    const s = memoryStore();
    saveReturnSpot(s, "starter-story", spot);
    expect(takeReturnSpot(s, "starter-story", "/starter-story/content", spot.at + 1)).toBeNull();
    expect(s.size()).toBe(0);
  });

  it("is scoped per brand", () => {
    const s = memoryStore();
    saveReturnSpot(s, "starter-story", spot);
    expect(takeReturnSpot(s, "futurepedia", href, spot.at + 1)).toBeNull();
    expect(takeReturnSpot(s, "starter-story", href, spot.at + 1)).toEqual(spot);
  });

  it("expires — coming back much later isn't coming back", () => {
    const s = memoryStore();
    saveReturnSpot(s, "starter-story", spot);
    expect(
      takeReturnSpot(s, "starter-story", href, spot.at + RETURN_SPOT_TTL_MS + 1),
    ).toBeNull();
  });

  it("survives junk in storage", () => {
    const s = memoryStore();
    s.setItem("hubspoke:contentReturn:starter-story", "{not json");
    expect(takeReturnSpot(s, "starter-story", href, 1)).toBeNull();
    s.setItem("hubspoke:contentReturn:starter-story", JSON.stringify({ id: 3 }));
    expect(takeReturnSpot(s, "starter-story", href, 1)).toBeNull();
  });

  it("only a plain left-click counts as opening in this tab", () => {
    const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(opensInThisTab(plain)).toBe(true);
    expect(opensInThisTab({ ...plain, metaKey: true })).toBe(false);
    expect(opensInThisTab({ ...plain, ctrlKey: true })).toBe(false);
    expect(opensInThisTab({ ...plain, button: 1 })).toBe(false);
  });
});
