import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DateRangePill } from "./filter-pills";

// Regression: GlitchTip HUBANDSPOKE-5 (React #418 on /:brand, 2026-11-06).
// The server renders in UTC; the browser hydrates in the user's timezone.
// At 9pm Pacific it is already tomorrow in UTC, so a pill label computed from
// `new Date()` read "Last 90 days" in the browser but a literal date range in
// the server HTML. The server render and the hydration render (which
// renderToString models: both take useSyncExternalStore's server snapshot)
// must produce the same text whatever the machine's timezone.

const ORIGINAL_TZ = process.env.TZ;

function renderPillIn(tz: string, props: { startDate: string; endDate: string }) {
  process.env.TZ = tz;
  return renderToString(
    createElement(DateRangePill, {
      ...props,
      onStartDateChange: () => {},
      onEndDateChange: () => {},
    }),
  );
}

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
  vi.useRealTimers();
});

describe("DateRangePill hydration", () => {
  // 2026-11-06 05:00 UTC = 2026-11-05 21:00 in Vancouver.
  const EVENING_PACIFIC = new Date("2026-11-06T05:00:00Z");

  it.each([
    // The browser's local "Last 90 days" (Aug 7 → Nov 6, end is today+1).
    { startDate: "2026-08-07", endDate: "2026-11-06" },
    // The server's UTC "Last 90 days".
    { startDate: "2026-08-08", endDate: "2026-11-07" },
    // The MATG default range as the browser computed it.
    { startDate: "2026-08-07", endDate: "2026-11-05" },
  ])("server and browser agree on the label for $startDate → $endDate", (range) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(EVENING_PACIFIC);

    const server = renderPillIn("UTC", range);
    const browserHydration = renderPillIn("America/Vancouver", range);
    expect(browserHydration).toBe(server);
  });
});
