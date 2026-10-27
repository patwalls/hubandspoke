import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { createTestProductionItem } from "@/test/factories";
import { hubspotEmailIdOf, syncRecentHubspotNewsletterStats } from "./hubspot-stats";

const itemOf = async (id: string) => (await db.select().from(productionItems).where(eq(productionItems.id, id)))[0];

describe("HubSpot newsletter stats", () => {
  it("writes opens as views, clicks and delivered on recent HubSpot issues only", async () => {
    const issue = await createTestProductionItem({ postType: "newsletter", platformContentId: `9${Date.now()}` });
    const klaviyo = await createTestProductionItem({ postType: "newsletter", platformContentId: `01J${Date.now()}` });
    const old = await createTestProductionItem({ postType: "newsletter", platformContentId: `8${Date.now()}`, publishedAt: new Date("2025-01-05T13:00:00Z") });
    const asked: string[] = [];
    const n = await syncRecentHubspotNewsletterStats(new Date(Date.now() - 86_400_000), async (id) => {
      asked.push(id);
      return { delivered: 236123, opens: 43030, clicks: 1593 };
    });

    expect(asked).toEqual([issue.platformContentId]);
    expect(n).toBe(1);
    const row = await itemOf(issue.id);
    expect([row.views, row.clicks, row.newsletterRecipients]).toEqual([43030, 1593, 236123]);
    expect(row.lastPerformanceSyncAt).not.toBeNull();
    expect((await itemOf(klaviyo.id)).lastPerformanceSyncAt).toBeNull();
    expect((await itemOf(old.id)).lastPerformanceSyncAt).toBeNull();
  });

  it("an unsent email keeps its numbers and notes why", async () => {
    const issue = await createTestProductionItem({ postType: "newsletter", platformContentId: `7${Date.now()}`, views: 5 });
    await syncRecentHubspotNewsletterStats(new Date(Date.now() - 86_400_000), async () => null);
    const row = await itemOf(issue.id);
    expect(row.views).toBe(5);
    expect(row.lastPerformanceSyncError).toMatch(/no stats/);
  });

  it("only Starter Story newsletters with a numeric id are HubSpot emails", () => {
    expect(hubspotEmailIdOf({ brand: "starter-story", postType: "newsletter", platformContentId: "225249832610" })).toBe("225249832610");
    expect(hubspotEmailIdOf({ brand: "futurepedia", postType: "newsletter", platformContentId: "225249832610" })).toBeNull();
    expect(hubspotEmailIdOf({ brand: "starter-story", postType: "x", platformContentId: "225249832610" })).toBeNull();
  });
});
