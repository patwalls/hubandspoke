import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The boot warmer must fill every production-report key a person loads:
// the queue page SSRs excludeIdea=false, the In Production list fetches
// excludeIdea=true. Only the first was warmed, so the busier screen paid the
// cold report (1.5-6 s) after every deploy.
const productionReport = vi.fn(async (_brand: string, _excludeIdea: boolean) => ({ items: [] }));

vi.mock("@/lib/services/production-report", () => ({
  getProductionReportCached: (brand: string, excludeIdea: boolean) => productionReport(brand, excludeIdea),
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
      "my-first-million:false",
      "my-first-million:true",
      "starter-story:false",
      "starter-story:true",
    ]);
  });

  it("?only=production rebuilds just In Production's key for every brand", async () => {
    const { GET } = await import("./route");
    const res = await GET(
      new NextRequest("http://localhost/api/warm?only=production", {
        headers: { authorization: "Bearer s3cret" },
      }),
    );
    expect(res.status).toBe(200);
    const calls = productionReport.mock.calls.map(([b, x]) => `${b}:${x}`).sort();
    expect(calls).toEqual(["my-first-million:true", "starter-story:true"]);
  });

  it("?only=production without the secret is a 401 noop", async () => {
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/warm?only=production"));
    expect(res.status).toBe(401);
    expect(productionReport).not.toHaveBeenCalled();
  });
});
