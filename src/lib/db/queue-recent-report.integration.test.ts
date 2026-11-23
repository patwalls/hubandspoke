import { describe, expect, it } from "vitest";
import {
  createTestContentEvent,
  createTestProductionItem,
} from "@/test/factories";
import { countOlderIdeasByFormat, getProductionPipeline } from "./queries";
import { queueAgeCutoff } from "@/lib/queue-age";

const DAY = 24 * 60 * 60 * 1000;

// clip-ideas-backlog M3: the queue's "Last 30 days" view loads a recent-only
// report. It must still carry every row that view can show (recent Idea rows,
// old Idea rows first edited recently, every non-Idea row) and count the rest.
describe("recent-only production report", () => {
  it("drops only Idea rows created and first edited over 30 days ago, and counts them by format", async () => {
    const brand = "starter-story";
    const format = `vitest-recent-${Date.now()}`;
    const cutoff = queueAgeCutoff(Date.now());
    const old = await createTestProductionItem({ brand, status: "Idea", format, createdAt: new Date(Date.now() - 90 * DAY) });
    const fresh = await createTestProductionItem({ brand, status: "Idea", format, createdAt: new Date(Date.now() - 2 * DAY) });
    const oldEdited = await createTestProductionItem({ brand, status: "Idea", format, createdAt: new Date(Date.now() - 90 * DAY) });
    await createTestContentEvent({ contentItemId: oldEdited.id, createdAt: new Date(Date.now() - 3 * DAY) });
    const oldAssigned = await createTestProductionItem({ brand, status: "Assigned", format, createdAt: new Date(Date.now() - 90 * DAY) });
    const oldCrossPost = await createTestProductionItem({ brand, status: "Idea", format, sourceType: "cross_post", createdAt: new Date(Date.now() - 90 * DAY) });

    const recent = new Set((await getProductionPipeline(brand, { ideasSince: cutoff })).map((i) => i.id));
    expect(recent.has(old.id)).toBe(false);
    expect(recent.has(fresh.id)).toBe(true);
    expect(recent.has(oldEdited.id)).toBe(true);
    expect(recent.has(oldAssigned.id)).toBe(true);

    const full = new Set((await getProductionPipeline(brand)).map((i) => i.id));
    expect(full.has(old.id)).toBe(true);

    const counts = await countOlderIdeasByFormat(brand, cutoff);
    // Only `old`: the edited one is shown, cross-posts aren't triage rows.
    expect(counts.byFormat[format]).toBe(1);
    expect(counts.clipByFormat[format]).toBeUndefined();
    expect(oldCrossPost.id).toBeTruthy();
  });
});
