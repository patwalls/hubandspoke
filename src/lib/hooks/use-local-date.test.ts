import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { formatDisplayDate, useLocalDate } from "./use-local-date";

// Regression: GlitchTip HUBANDSPOKE-6 (issue 45, React #418 on
// /:brand/accounts, 2026-11-08). A timestamp from server props formatted with
// toLocaleDateString() reads "10/19/2026" in the UTC server HTML and
// "10/20/2026" (or "19.10.2026") in the browser.

const ORIGINAL_TZ = process.env.TZ;
const AT = "2026-10-20T02:30:00.000Z"; // 10/19 evening in Chicago, 10/20 in UTC

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("formatDisplayDate", () => {
  it("pre-hydration output ignores the machine timezone", () => {
    process.env.TZ = "UTC";
    const server = formatDisplayDate(AT, false);
    process.env.TZ = "America/Chicago";
    expect(formatDisplayDate(AT, false)).toBe(server);
    expect(server).toBe("10/20/2026");
  });

  it("post-hydration output uses the machine timezone", () => {
    process.env.TZ = "America/Chicago";
    expect(formatDisplayDate(AT, true)).toBe("10/19/2026");
  });

  it("passes format options through in both passes", () => {
    process.env.TZ = "UTC";
    const options = { month: "short", day: "numeric" } as const;
    expect(formatDisplayDate(AT, false, options)).toBe("Oct 20");
    expect(formatDisplayDate(AT, true, options)).toBe("Oct 20");
  });
});

describe("useLocalDate", () => {
  it("renders the stable form on the server whatever the timezone", () => {
    const Probe = () => createElement("span", null, useLocalDate()(AT));
    process.env.TZ = "America/Chicago";
    expect(renderToString(createElement(Probe))).toContain("10/20/2026");
  });
});
