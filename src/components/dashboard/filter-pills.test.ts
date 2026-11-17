import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DateRangePill } from "./filter-pills";
import { ServerTodayProvider } from "@/lib/hooks/use-today";

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

// Regression: GlitchTip issue 78 (React #418 on /:brand/content, 2026-11-17).
// The server rendered at 20:23 UTC on Nov 16; the tab (Chicago) sat frozen in
// the background and hydrated at 16:12 UTC on Nov 17. The hydration pass took
// "today" from the browser's clock — a day later — so a range the server
// labelled with a preset read as a literal date range. The server's date has
// to reach the browser; the layout sends it via <ServerTodayProvider>.
describe("DateRangePill hydrating long after the server render", () => {
  const SERVER_RENDER = new Date("2026-11-16T20:23:31Z");
  const LATE_HYDRATION = new Date("2026-11-17T16:12:48Z");
  const serverDate = SERVER_RENDER.toISOString().slice(0, 10);

  function render(tz: string, at: Date, range: { startDate: string; endDate: string }) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    process.env.TZ = tz;
    return renderToString(
      createElement(
        ServerTodayProvider,
        { utcDate: serverDate },
        createElement(DateRangePill, {
          ...range,
          onStartDateChange: () => {},
          onEndDateChange: () => {},
        }),
      ),
    );
  }

  it.each([
    { label: "Today", startDate: "2026-11-16", endDate: "2026-11-17" },
    { label: "Last 30 days", startDate: "2026-10-17", endDate: "2026-11-17" },
  ])("keeps the server's '$label' label on a next-day hydration", ({ label, ...range }) => {
    const server = render("UTC", SERVER_RENDER, range);
    expect(server).toContain(label);
    expect(render("America/Chicago", LATE_HYDRATION, range)).toBe(server);
  });
});
