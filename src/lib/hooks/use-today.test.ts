import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { clientTodaySnapshot, useToday } from "./use-today";

// HUBANDSPOKE-5: "today" in render must be the same on the server (UTC) and
// on the browser's hydration pass, whatever the browser's timezone.
const ORIGINAL_TZ = process.env.TZ;

function Probe() {
  const t = useToday();
  return createElement("span", null, `${t.key}/${t.inclusiveOfUtc}`);
}

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
  vi.useRealTimers();
});

describe("useToday", () => {
  it("renders the UTC date on the server/hydration pass in any timezone", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T05:00:00Z")); // Nov 5, 9pm Pacific
    for (const tz of ["UTC", "America/Vancouver", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      expect(renderToString(createElement(Probe))).toBe(
        "<span>2026-11-06/2026-11-06</span>",
      );
    }
  });

  it("settles to the local date after hydration", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T05:00:00Z"));
    process.env.TZ = "America/Vancouver";
    // Local Nov 5; the report upper bound still reaches UTC's Nov 6.
    expect(clientTodaySnapshot()).toBe("2026-11-05|2026-11-06");
  });
});
