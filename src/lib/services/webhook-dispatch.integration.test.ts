import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiWebhookDeliveries, apiWebhookItemState, apiWebhooks, productionItems } from "@/lib/db/schema";
import { createTestAccount, createTestProductionItem, createTestTranscript, createTestUser } from "@/test/factories";

// No worker in tests — capture what would be queued instead.
const enqueued: Array<{ name: string; payload: unknown }> = [];
vi.mock("@/jobs/enqueue", () => ({ enqueue: async (name: string, payload: unknown) => void enqueued.push({ name, payload }) }));

const { runWebhookDispatchSweep } = await import("./webhook-dispatch");

async function subscribe(userId: string, events: string[], brand: string | null = null) {
  const [row] = await db
    .insert(apiWebhooks)
    .values({ userId, name: "t", url: "https://example.invalid/hook", events, secret: "whsec_t", brand })
    .returning();
  return row;
}

describe("runWebhookDispatchSweep", () => {
  it("seeds silently, then turns a status move into deliveries for matching subscriptions only", async () => {
    const user = await createTestUser({ role: "admin" });
    const account = await createTestAccount({ brand: "starter-story", platform: "x" });
    // First sweep (or an already-seeded table) must never announce history.
    const before = await createTestProductionItem({ accountId: account.id, status: "Idea" });
    await runWebhookDispatchSweep();
    const seeded = await db.select().from(apiWebhookItemState).where(eq(apiWebhookItemState.itemId, before.id));
    expect(seeded).toHaveLength(1);

    const wantsStatus = await subscribe(user.id, ["content.status_changed"]);
    const wantsPublished = await subscribe(user.id, ["content.published"]);
    const otherBrand = await subscribe(user.id, ["content.status_changed"], "futurepedia");
    try {
      enqueued.length = 0;
      await db.update(productionItems).set({ status: "Editing", updatedAt: new Date() }).where(eq(productionItems.id, before.id));
      const r = await runWebhookDispatchSweep();
      expect(r.events).toBeGreaterThanOrEqual(1);

      const forStatus = await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.webhookId, wantsStatus.id));
      expect(forStatus).toHaveLength(1);
      expect(forStatus[0].event).toBe("content.status_changed");
      expect(forStatus[0].payload).toMatchObject({ from: "Idea", to: "Editing", content: { id: before.id } });
      expect(await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.webhookId, wantsPublished.id))).toHaveLength(0);
      expect(await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.webhookId, otherBrand.id))).toHaveLength(0);
      expect(enqueued.filter((e) => e.name === "webhook-deliver")).toHaveLength(1);

      // Running again with nothing changed is a no-op (no duplicate deliveries).
      await runWebhookDispatchSweep();
      expect(await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.webhookId, wantsStatus.id))).toHaveLength(1);

      // Publishing fires both events.
      await db.update(productionItems).set({ status: "Published", updatedAt: new Date() }).where(eq(productionItems.id, before.id));
      await runWebhookDispatchSweep();
      const pub = await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.webhookId, wantsPublished.id));
      expect(pub.map((d) => d.event)).toEqual(["content.published"]);
    } finally {
      for (const w of [wantsStatus, wantsPublished, otherBrand]) await db.delete(apiWebhooks).where(eq(apiWebhooks.id, w.id));
    }
  });

  it("a new item after the sweep started is content.created; a fresh transcript is transcript.ready", async () => {
    const user = await createTestUser({ role: "admin" });
    const account = await createTestAccount({ brand: "starter-story", platform: "youtube" });
    await runWebhookDispatchSweep();
    const sub = await subscribe(user.id, ["content.created", "transcript.ready"]);
    try {
      const item = await createTestProductionItem({ accountId: account.id, status: "Idea" });
      await runWebhookDispatchSweep();
      let rows = await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.webhookId, sub.id));
      expect(rows.map((d) => d.event)).toEqual(["content.created"]);

      await createTestTranscript({ productionItemId: item.id, segments: [{ startSec: 0, endSec: 1, text: "hi" }] });
      await runWebhookDispatchSweep();
      rows = await db
        .select()
        .from(apiWebhookDeliveries)
        .where(and(eq(apiWebhookDeliveries.webhookId, sub.id), eq(apiWebhookDeliveries.event, "transcript.ready")));
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ content: { id: item.id } });
      // Idempotent: the same transcript doesn't fire twice.
      await runWebhookDispatchSweep();
      rows = await db
        .select()
        .from(apiWebhookDeliveries)
        .where(and(eq(apiWebhookDeliveries.webhookId, sub.id), eq(apiWebhookDeliveries.event, "transcript.ready")));
      expect(rows).toHaveLength(1);
    } finally {
      await db.delete(apiWebhooks).where(eq(apiWebhooks.id, sub.id));
    }
  });
});
