import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { AccountStatusCell } from "./accounts-settings";
import { ShortLinksSettings } from "./short-links-settings";
import { SyncErrorsTable } from "./sync-errors-table";
import { BrandAssetsSettings } from "./brand-assets-settings";
import { ScheduledReview } from "@/components/dashboard/scheduled-review";
import type { ShortLink } from "@/lib/services/short-links";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/b/scheduled",
  useSearchParams: () => new URLSearchParams(),
}));

// Regression: GlitchTip HUBANDSPOKE-6 (issue 45). These surfaces render
// timestamps that arrive as server props, so they are in the server HTML.
// renderToString models both the server pass and the hydration pass; the
// output must not depend on the machine's timezone or on the clock moving on
// between the two passes.

const ORIGINAL_TZ = process.env.TZ;
// 2026-10-20 02:30 UTC is still 10/19 in Chicago.
const AT = "2026-10-20T02:30:00.000Z";
const NOW = new Date("2026-10-20T03:00:10.000Z");

function renderAt(tz: string, now: Date, el: () => ReactElement) {
  process.env.TZ = tz;
  vi.useFakeTimers({ now, toFake: ["Date"] });
  try {
    return renderToString(el());
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
  vi.useRealTimers();
});

const link = { id: "l1", slug: "abc", targetUrl: "https://example.com", lastClickedAt: "2026-09-16T02:30:00.000Z", clickCount: 3, createdAt: AT } as unknown as ShortLink;

const CASES: Array<[string, () => ReactElement]> = [
  ["AccountStatusCell", () => createElement(AccountStatusCell, { at: AT, error: null })],
  ["AccountStatusCell with a warning", () => createElement(AccountStatusCell, { at: AT, error: "rate limit" })],
  ["ShortLinksSettings", () => createElement(ShortLinksSettings, { initialLinks: [link], baseUrl: "https://s.example", initialError: null })],
  ["SyncErrorsTable", () => createElement(SyncErrorsTable, { items: [{ id: "i1", brand: "b", title: "t", lastPerformanceSyncAt: AT, lastPerformanceSyncError: "x", url: null, platform: [] } as never] })],
  ["BrandAssetsSettings", () => createElement(BrandAssetsSettings, { brand: "b", brandLabel: "B", initialWatermarks: [{ id: "w1", fileName: "logo.png", sizeBytes: 10, createdAt: AT }], initialGuidelines: null, initialCtaFallbackUrl: null })],
  ["ScheduledReview", () => createElement(ScheduledReview, { brand: "b", initialData: { suggestions: [], needsAttention: [{ id: "n1", title: "t", postType: null, scheduledAt: AT, expectedPublishAt: AT }], watching: [] } })],
];

describe.each(CASES)("%s hydration", (_name, el) => {
  it("renders the same HTML for a UTC server and a Chicago browser", () => {
    expect(renderAt("America/Chicago", NOW, el)).toBe(renderAt("UTC", NOW, el));
  });

  it("renders the same HTML when the minute rolls over before hydration", () => {
    const later = new Date(NOW.getTime() + 60_000);
    expect(renderAt("UTC", later, el)).toBe(renderAt("UTC", NOW, el));
  });
});
