import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiWebhookDeliveries, apiWebhooks } from "@/lib/db/schema";
import { verifyWebhookSignature } from "@/lib/api/webhooks";
import { createTestUser } from "@/test/factories";
import { DISABLE_AFTER_FAILURES, deliverWebhook } from "./webhook-dispatch";

let server: Server;
let port = 0;
let nextStatus = 200;
const received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.statusCode = nextStatus;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function makeHook(userId: string) {
  const [hook] = await db
    .insert(apiWebhooks)
    .values({ userId, name: "t", url: `http://127.0.0.1:${port}/hook`, events: ["ping"], secret: "whsec_local" })
    .returning();
  const [delivery] = await db
    .insert(apiWebhookDeliveries)
    .values({ webhookId: hook.id, event: "ping", payload: { message: "hi" } })
    .returning();
  return { hook, delivery };
}

describe("deliverWebhook", () => {
  it("POSTs a signed body and marks the delivery delivered on 2xx", async () => {
    const user = await createTestUser();
    const { hook, delivery } = await makeHook(user.id);
    try {
      nextStatus = 200;
      received.length = 0;
      await deliverWebhook(delivery.id, 1, 8);
      expect(received).toHaveLength(1);
      const r = received[0];
      expect(r.headers["x-hubspoke-event"]).toBe("ping");
      expect(r.headers["x-hubspoke-delivery"]).toBe(delivery.id);
      expect(r.headers["content-type"]).toBe("application/json");
      expect(verifyWebhookSignature("whsec_local", String(r.headers["x-hubspoke-timestamp"]), r.body, String(r.headers["x-hubspoke-signature"]))).toBe(true);
      expect(JSON.parse(r.body)).toMatchObject({ id: delivery.id, event: "ping", data: { message: "hi" } });

      const [d] = await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.id, delivery.id));
      expect(d.status).toBe("delivered");
      expect(d.lastStatusCode).toBe(200);
      const [h] = await db.select().from(apiWebhooks).where(eq(apiWebhooks.id, hook.id));
      expect(h.lastSuccessAt).toBeTruthy();
      expect(h.consecutiveFailures).toBe(0);
      // Re-delivering a delivered row is a no-op.
      await deliverWebhook(delivery.id, 2, 8);
      expect(received).toHaveLength(1);
    } finally {
      await db.delete(apiWebhooks).where(eq(apiWebhooks.id, hook.id));
    }
  });

  it("throws on a non-2xx so the worker retries, and marks failed + pauses the hook after the final attempt", async () => {
    const user = await createTestUser();
    const { hook, delivery } = await makeHook(user.id);
    try {
      nextStatus = 500;
      await expect(deliverWebhook(delivery.id, 1, 8)).rejects.toThrow(/HTTP 500/);
      let [d] = await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.id, delivery.id));
      expect(d.status).toBe("pending");
      expect(d.attempts).toBe(1);
      expect(d.lastError).toBe("HTTP 500");
      let [h] = await db.select().from(apiWebhooks).where(eq(apiWebhooks.id, hook.id));
      expect(h.consecutiveFailures).toBe(0); // not final yet

      await db.update(apiWebhooks).set({ consecutiveFailures: DISABLE_AFTER_FAILURES - 1 }).where(eq(apiWebhooks.id, hook.id));
      await expect(deliverWebhook(delivery.id, 8, 8)).rejects.toThrow();
      [d] = await db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.id, delivery.id));
      expect(d.status).toBe("failed");
      [h] = await db.select().from(apiWebhooks).where(eq(apiWebhooks.id, hook.id));
      expect(h.consecutiveFailures).toBe(DISABLE_AFTER_FAILURES);
      expect(h.active).toBe(false);
      expect(h.lastFailureAt).toBeTruthy();
    } finally {
      await db.delete(apiWebhooks).where(eq(apiWebhooks.id, hook.id));
    }
  });
});
