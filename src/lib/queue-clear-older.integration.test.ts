import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentEvents } from "@/lib/db/schema";
import {
  clipIdeas,
  createTestClipIdea,
  createTestProductionItem,
  productionItems,
} from "@/test/factories";
import { countOlderIdeas, killOlderIdeas } from "./queue-clear-older.server";

const DAY = 24 * 60 * 60 * 1000;

describe("killOlderIdeas", () => {
  it("kills only the brand's (and format's) Idea rows older than 30 days, with the reason on each", async () => {
    const brand = "starter-story";
    const format = `vitest-fmt-${Date.now()}`;
    const old = await createTestProductionItem({ brand, status: "Idea", format, createdAt: new Date(Date.now() - 90 * DAY) });
    const idea = await createTestClipIdea({ sourceProductionItemId: old.id });
    await db.update(productionItems).set({ sourceClipIdeaId: idea.id }).where(eq(productionItems.id, old.id));
    const fresh = await createTestProductionItem({ brand, status: "Idea", format, createdAt: new Date(Date.now() - 2 * DAY) });
    const oldAssigned = await createTestProductionItem({ brand, status: "Assigned", format, createdAt: new Date(Date.now() - 90 * DAY) });
    const oldCrossPost = await createTestProductionItem({ brand, status: "Idea", format, sourceType: "cross_post", createdAt: new Date(Date.now() - 90 * DAY) });
    const otherFormat = await createTestProductionItem({ brand, status: "Idea", format: `${format}-other`, createdAt: new Date(Date.now() - 90 * DAY) });

    expect(await countOlderIdeas(brand, format)).toBe(1);
    const killed = await killOlderIdeas({ brand, format, reason: "untouched for months", actorUserId: null });
    expect(killed).toBe(1);

    const statusOf = async (id: string) =>
      (await db.select({ s: productionItems.status }).from(productionItems).where(eq(productionItems.id, id)))[0].s;
    expect(await statusOf(old.id)).toBe("Killed");
    expect(await statusOf(fresh.id)).toBe("Idea");
    expect(await statusOf(oldAssigned.id)).toBe("Assigned");
    expect(await statusOf(oldCrossPost.id)).toBe("Idea");
    expect(await statusOf(otherFormat.id)).toBe("Idea");

    const [ev] = await db
      .select({ payload: contentEvents.payload })
      .from(contentEvents)
      .where(and(eq(contentEvents.contentItemId, old.id), eq(contentEvents.eventType, "killed")));
    expect(ev.payload).toMatchObject({ type: "killed", from: "Idea", reason: "untouched for months", bulk: "clear-older" });

    const [ci] = await db.select().from(clipIdeas).where(eq(clipIdeas.id, idea.id));
    expect(ci.status).toBe("killed");
    expect(ci.killReason).toBe("untouched for months");

    expect(await countOlderIdeas(brand, format)).toBe(0);
  });
});
