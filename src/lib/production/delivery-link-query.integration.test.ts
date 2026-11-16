import { describe, it, expect } from "vitest";
import { createTestComment, createTestProductionItem, getTestUserId } from "@/test/factories";
import { loadDeliveryLinks } from "./delivery-link-query";

// The one loader behind both the In Production Review rows and the content
// page's Review chip: open comments only, links since the post entered its
// status (10-min grace), newest comment wins.
describe("loadDeliveryLinks", () => {
  it("picks the newest open link since the status move, skipping resolved and older ones", async () => {
    const userId = await getTestUserId();
    const item = await createTestProductionItem({ status: "Review" });
    const entered = new Date(Date.now() - 60 * 60 * 1000);
    await createTestComment({
      contentItemId: item.id,
      userId,
      body: '<p><a href="https://canva.link/before">old round</a></p>',
      createdAt: new Date(entered.getTime() - 2 * 60 * 60 * 1000),
    });
    await createTestComment({
      contentItemId: item.id,
      userId,
      body: '<p>review &amp; publish <a href="https://studio.youtube.com/video/abc/edit">link</a></p>',
      createdAt: new Date(entered.getTime() + 5 * 60 * 1000),
    });
    const other = await createTestProductionItem({ status: "Review" });

    const links = await loadDeliveryLinks([
      { id: item.id, statusSince: entered },
      { id: other.id, statusSince: entered },
    ]);
    expect(links.get(item.id)?.url).toBe("https://studio.youtube.com/video/abc/edit");
    expect(links.get(item.id)?.label).toBe("YouTube Studio");
    expect(links.has(other.id)).toBe(false);
  });

  it("returns an empty map without querying when there are no items", async () => {
    expect((await loadDeliveryLinks([])).size).toBe(0);
  });
});
