import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The boot warmer must fill every production-report key a person loads by
// default: the queue page's "Last 30 days" view SSRs `recent-ideas`, the In
// Production list fetches `no-ideas`. Only the first was warmed once, so the
// busier screen paid the cold report (1.5-6 s) after every deploy; and until
// queueRecentOnly graduated (2026-11-23) the queue key warmed was the full
// `all` report, which nobody's default view loads any more.
const productionReport = vi.fn(async (_brand: string, _scope: unknown) => ({ items: [] }));

vi.mock("@/lib/services/production-report", () => ({
  getProductionReportCached: (brand: string, scope: unknown) => productionReport(brand, scope),
}));
vi.mock("@/lib/db/queries-cached", () => ({ getContentReportCached: async () => ({}) }));
vi.mock("@/lib/services/sc-credits-watch", () => ({ getScCreditsExhaustionState: async () => ({}) }));
vi.mock("@/lib/services/descript-credits-watch", () => ({ getDescriptCreditsExhaustionState: async () => ({}) }));
vi.mock("@/lib/db/brands", () => ({
  getEnabledBrands: async () => [{ slug: "starter-story" }, { slug: "my-first-million" }],
}));
vi.mock("@/lib/services/production-item-detail", () => ({ getProductionItemDetail: async () => ({}) }));
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }) },
}));

describe("GET /api/warm", () => {
  beforeEach(() => {
    productionReport.mockClear();
    process.env.CRON_SECRET = "s3cret";
  });

  it("warms the production report for both the queue and In Production", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest("http://localhost/api/warm", { headers: { authorization: "Bearer s3cret" } }),
    );
    expect(res.status).toBe(200);
    const calls = productionReport.mock.calls.map(([b, x]) => `${b}:${x}`).sort();
    expect(calls).toEqual([
      "my-first-million:no-ideas",
      "my-first-million:recent-ideas",
      "starter-story:no-ideas",
      "starter-story:recent-ideas",
    ]);
  });

  it("?only=production rebuilds both keys (In Production and the queue) for every brand", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest("http://localhost/api/warm?only=production", {
        headers: { authorization: "Bearer s3cret" },
      }),
    );
    expect(res.status).toBe(200);
    const calls = productionReport.mock.calls.map(([b, x]) => `${b}:${x}`).sort();
    expect(calls).toEqual([
      "my-first-million:no-ideas",
      "my-first-million:recent-ideas",
      "starter-story:no-ideas",
      "starter-story:recent-ideas",
    ]);
  });

  it("?only=production&brands= rebuilds just the brands an edit expired", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest("http://localhost/api/warm?only=production&brands=my-first-million,not-a-brand", {
        headers: { authorization: "Bearer s3cret" },
      }),
    );
    expect(res.status).toBe(200);
    const calls = productionReport.mock.calls.map(([b, x]) => `${b}:${x}`);
    // In Production's key first (the busier screen), then the queue's.
    expect(calls).toEqual(["my-first-million:no-ideas", "my-first-million:recent-ideas"]);
  });

  it("?only=production without the secret is a 401 noop", async () => {
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/warm?only=production"));
    expect(res.status).toBe(401);
    expect(productionReport).not.toHaveBeenCalled();
  });
});
