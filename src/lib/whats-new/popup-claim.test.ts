import { describe, it, expect } from "vitest";
import { shouldShowPopup } from "./popup-claim";
import { POPUP_COOLDOWN_HOURS } from "./index";

const HOUR = 3_600_000;
const now = Date.parse("2026-11-08T18:00:00Z");

describe("shouldShowPopup", () => {
  it("shows on the first load of the day", () => {
    expect(shouldShowPopup(null, now)).toBe(true);
  });

  // The bug: five posts opened in five tabs seconds apart each popped it.
  it("stays quiet in a second tab opened seconds after the first showed it", () => {
    expect(shouldShowPopup(String(now - 2_000), now)).toBe(false);
  });

  it("stays quiet on later loads the same day even if the first was never dismissed", () => {
    expect(shouldShowPopup(String(now - 6 * HOUR), now)).toBe(false);
  });

  it("shows again once the cooldown has passed", () => {
    expect(shouldShowPopup(String(now - POPUP_COOLDOWN_HOURS * HOUR), now)).toBe(true);
  });

  it("ignores a garbage or future claim instead of silencing the pop-up for good", () => {
    expect(shouldShowPopup("abc", now)).toBe(true);
    expect(shouldShowPopup(String(now + 48 * HOUR), now)).toBe(true);
  });
});
