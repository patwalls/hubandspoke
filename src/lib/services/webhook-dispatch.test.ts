import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@/lib/api/webhooks";
import { buildDeliveryRequest, diffItem } from "./webhook-dispatch";

const base = {
  id: "7a9c1e9e-5b1c-4b61-9d4f-2f0a1a0c5d21",
  brand: "starter-story",
  title: "T",
  postType: "x",
  format: null,
  publishedLink: null,
  publishedAt: null,
  createdAt: new Date("2026-10-30T12:00:00Z"),
  updatedAt: new Date("2026-10-30T12:05:00Z"),
};
const sweepStart = new Date("2026-10-30T11:00:00Z");

describe("diffItem", () => {
  it("announces a brand-new item once, but never one that predates the sweep", () => {
    expect(diffItem({ ...base, status: "Idea" }, null, sweepStart).map((e) => e.event)).toEqual(["content.created"]);
    expect(diffItem({ ...base, status: "Idea", createdAt: new Date("2026-10-01") }, null, sweepStart)).toEqual([]);
  });
  it("a status move is one event; moving to Published is two", () => {
    expect(diffItem({ ...base, status: "Editing" }, { status: "Idea" }, sweepStart).map((e) => e.event)).toEqual(["content.status_changed"]);
    const pub = diffItem({ ...base, status: "Published" }, { status: "Ready To Publish" }, sweepStart);
    expect(pub.map((e) => e.event)).toEqual(["content.status_changed", "content.published"]);
    expect(pub[0].data).toMatchObject({ from: "Ready To Publish", to: "Published" });
  });
  it("no status change means no event, even if other columns moved", () => {
    expect(diffItem({ ...base, status: "Idea" }, { status: "Idea" }, sweepStart)).toEqual([]);
    expect(diffItem({ ...base, status: null }, { status: null }, sweepStart)).toEqual([]);
  });
});

describe("delivery signing", () => {
  it("signs timestamp.body and the receiver can verify it", () => {
    const { body, headers } = buildDeliveryRequest({
      secret: "whsec_test",
      deliveryId: "d1",
      event: "content.published",
      data: { content: { id: base.id } },
      createdAt: base.createdAt,
      now: new Date(1_761_850_000_000),
    });
    expect(JSON.parse(body)).toMatchObject({ id: "d1", event: "content.published", data: { content: { id: base.id } } });
    expect(headers["X-HubSpoke-Timestamp"]).toBe("1761850000");
    expect(headers["X-HubSpoke-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature("whsec_test", headers["X-HubSpoke-Timestamp"], body, headers["X-HubSpoke-Signature"])).toBe(true);
    expect(verifyWebhookSignature("whsec_other", headers["X-HubSpoke-Timestamp"], body, headers["X-HubSpoke-Signature"])).toBe(false);
    expect(verifyWebhookSignature("whsec_test", "1", body, headers["X-HubSpoke-Signature"])).toBe(false);
  });
});
