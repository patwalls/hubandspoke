/**
 * Integration test for the Klaviyo discovery sync. Hits real Postgres for
 * the upsert behavior (this is the load-bearing piece — duplicate inserts
 * would burn the global unique index on platform_content_id), but stubs
 * out `fetch` so we don't talk to Klaviyo.
 *
 * Pins:
 *   • Re-running the sync with the same campaign id yields one row.
 *   • The second run does an UPDATE, not an INSERT (drift in
 *     publishedAt / title is reflected; createdVia stays).
 *   • Campaigns whose `audiences.included` doesn't contain the account's
 *     external_id are skipped.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, brands, productionItems } from "@/lib/db/schema";
import { syncKlaviyoCampaigns } from "./klaviyo-sync";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const TEST_HANDLE = `vitest-klaviyo-${Date.now().toString(36)}`;
const KLAVIYO_LIST_ID = "VITEST_LIST";
let testAccountId: string | null = null;
const insertedItemIds: string[] = [];

beforeAll(async () => {
  process.env.KLAVIYO_API_KEY = "vitest-key";

  const [brand] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(eq(brands.slug, "starter-story"))
    .limit(1);
  if (!brand) {
    throw new Error("starter-story brand not seeded — run scripts/seed-brand.mjs?");
  }

  const [acct] = await db
    .insert(accounts)
    .values({
      brandId: brand.id,
      platform: "newsletter",
      handle: TEST_HANDLE,
      externalId: KLAVIYO_LIST_ID,
      url: "https://example.test/",
      isActive: true,
    })
    .returning({ id: accounts.id });
  testAccountId = acct.id;
});

afterAll(async () => {
  // Clean up rows we created. Best-effort.
  for (const id of insertedItemIds) {
    try {
      await db.delete(productionItems).where(eq(productionItems.id, id));
    } catch {}
  }
  if (testAccountId) {
    try {
      await db.delete(accounts).where(eq(accounts.id, testAccountId));
    } catch {}
  }
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

beforeEach(() => {
  process.env.KLAVIYO_API_KEY = "vitest-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubCampaignsResponse(campaigns: Array<{
  id: string;
  name: string;
  status: string;
  send_time: string | null;
  included?: string[];
}>): void {
  const body = JSON.stringify({
    data: campaigns.map((c) => ({
      type: "campaign",
      id: c.id,
      attributes: {
        name: c.name,
        status: c.status,
        send_time: c.send_time,
        audiences: { included: c.included ?? [KLAVIYO_LIST_ID], excluded: [] },
      },
    })),
    links: { next: null },
  });
  globalThis.fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/vnd.api+json" },
      }),
    ) as unknown as typeof fetch;
}

async function findOurItems(accountId: string) {
  return db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      platformContentId: productionItems.platformContentId,
      createdVia: productionItems.createdVia,
      postType: productionItems.postType,
      klaviyoListId: productionItems.klaviyoListId,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.accountId, accountId),
        eq(productionItems.postType, "newsletter"),
      ),
    );
}

describe("syncKlaviyoCampaigns", () => {
  it("inserts new campaigns once and updates them on a re-run (no duplicates)", async () => {
    if (!testAccountId) throw new Error("test account not set up");
    const campaignId = `vitest-camp-${Date.now()}`;
    stubCampaignsResponse([
      {
        id: campaignId,
        name: "Vitest newsletter v1",
        status: "Sent",
        send_time: "2026-04-15T10:00:00Z",
      },
    ]);

    const first = await syncKlaviyoCampaigns(testAccountId);
    expect(first.created).toBe(1);
    expect(first.updated).toBe(0);
    expect(first.insertedItemIds).toHaveLength(1);
    insertedItemIds.push(...first.insertedItemIds);

    const afterFirst = await findOurItems(testAccountId);
    const ourFirst = afterFirst.find((r) => r.platformContentId === campaignId);
    expect(ourFirst).toBeDefined();
    expect(ourFirst?.title).toBe("Vitest newsletter v1");
    expect(ourFirst?.createdVia).toBe("sync:klaviyo");
    expect(ourFirst?.klaviyoListId).toBe(KLAVIYO_LIST_ID);

    // Second sync: same campaign id, edited subject. Must NOT create a
    // duplicate row — the (account_id, platform_content_id) partial
    // unique index would also reject it, but the service should choose
    // UPDATE before reaching that point.
    stubCampaignsResponse([
      {
        id: campaignId,
        name: "Vitest newsletter v1 (updated subject)",
        status: "Sent",
        send_time: "2026-04-15T10:00:00Z",
      },
    ]);
    const second = await syncKlaviyoCampaigns(testAccountId);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const afterSecond = await findOurItems(testAccountId);
    expect(
      afterSecond.filter((r) => r.platformContentId === campaignId),
    ).toHaveLength(1);
    const updatedRow = afterSecond.find(
      (r) => r.platformContentId === campaignId,
    );
    expect(updatedRow?.title).toBe("Vitest newsletter v1 (updated subject)");
  });

  it("skips campaigns that don't target the account's list", async () => {
    if (!testAccountId) throw new Error("test account not set up");
    const otherCampaignId = `vitest-camp-other-${Date.now()}`;
    stubCampaignsResponse([
      {
        id: otherCampaignId,
        name: "Targeting a different list",
        status: "Sent",
        send_time: "2026-04-16T10:00:00Z",
        included: ["SOME_OTHER_LIST"],
      },
    ]);

    const result = await syncKlaviyoCampaigns(testAccountId);
    expect(result.created).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const all = await findOurItems(testAccountId);
    expect(all.find((r) => r.platformContentId === otherCampaignId)).toBeUndefined();
  });

  it("skips drafts and other non-Sent statuses", async () => {
    if (!testAccountId) throw new Error("test account not set up");
    const draftId = `vitest-camp-draft-${Date.now()}`;
    stubCampaignsResponse([
      {
        id: draftId,
        name: "Still a draft",
        status: "Draft",
        send_time: null,
      },
    ]);
    const result = await syncKlaviyoCampaigns(testAccountId);
    expect(result.created).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});
