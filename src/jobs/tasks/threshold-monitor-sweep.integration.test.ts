/**
 * Integration test for threshold-monitor-sweep's clippable-format guard.
 *
 * Hits the real local Postgres (DATABASE_URL from .env.local). `enqueue`
 * and `recordItemCreated` are mocked so no jobs land in the real queue and
 * no content_events rows are written.
 *
 * The sweep is a global scan (no payload scoping), so it processes every
 * published item in the dev DB, not just our fixtures. We snapshot the
 * production_items / repurpose_triggers id sets *after* creating fixtures
 * but *before* running the sweep, then purge the diff in afterEach so the
 * sweep's output for unrelated real pillars doesn't leak into the dev DB.
 */
import {
  describe,
  it,
  expect,
  afterEach,
  vi,
} from "vitest";
import { eq, inArray } from "drizzle-orm";

// Hoisted before the module under test is imported.
vi.mock("@/jobs/enqueue", () => ({
  enqueue: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/services/item-created", () => ({
  recordItemCreated: vi.fn().mockResolvedValue(undefined),
}));

import { thresholdMonitorSweepTask } from "./threshold-monitor-sweep";
import { db } from "@/lib/db";
import { productionItems, repurposeTriggers } from "@/lib/db/schema";
import { createTestFormat, createTestProductionItem } from "@/test/factories";

function fakeHelpers() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as Parameters<typeof thresholdMonitorSweepTask>[1];
}

// Sweep-created rows (NOT tracked by the factory) — purged below. The
// factory's own afterEach cleans the fixtures (formats + pillar); the
// trigger→format RESTRICT FK is satisfied because a fixture-pillar delete
// cascade-removes its triggers, and any remaining diff triggers are deleted
// here. Order-independent: works whether this afterEach or the factory's
// runs first.
let preItemIds: Set<string> = new Set();
let preTriggerIds: Set<string> = new Set();

afterEach(async () => {
  const postTriggers = await db
    .select({ id: repurposeTriggers.id })
    .from(repurposeTriggers);
  const newTriggerIds = postTriggers
    .map((t) => t.id)
    .filter((id) => !preTriggerIds.has(id));
  if (newTriggerIds.length) {
    await db
      .delete(repurposeTriggers)
      .where(inArray(repurposeTriggers.id, newTriggerIds));
  }

  const postItems = await db
    .select({ id: productionItems.id })
    .from(productionItems);
  const newItemIds = postItems
    .map((i) => i.id)
    .filter((id) => !preItemIds.has(id));
  if (newItemIds.length) {
    await db
      .delete(productionItems)
      .where(inArray(productionItems.id, newItemIds));
  }
});

describe("thresholdMonitorSweepTask — clippable-format guard", () => {
  it("creates a repurposed Idea for a non-clippable child but skips the clippable one", async () => {
    const suffix = `${Date.now()}`;
    const parent = await createTestFormat({ name: `vitest-parent-${suffix}` });
    const normalChild = await createTestFormat({
      name: `vitest-normal-${suffix}`,
      parentFormatId: parent.id,
      isClippableFormat: false,
      viewThreshold: 1000,
    });
    const clipChild = await createTestFormat({
      name: `vitest-clip-${suffix}`,
      parentFormatId: parent.id,
      isClippableFormat: true,
      viewThreshold: 1000,
    });
    // Published pillar whose views clear BOTH children's thresholds.
    const pillar = await createTestProductionItem({
      status: "Published",
      format: parent.name,
      views: 50_000,
    });

    // Snapshot now so the post-sweep diff is purely sweep output.
    preItemIds = new Set(
      (await db.select({ id: productionItems.id }).from(productionItems)).map(
        (r) => r.id,
      ),
    );
    preTriggerIds = new Set(
      (await db.select({ id: repurposeTriggers.id }).from(repurposeTriggers)).map(
        (r) => r.id,
      ),
    );

    await thresholdMonitorSweepTask({}, fakeHelpers());

    const repurposed = await db
      .select({ format: productionItems.format })
      .from(productionItems)
      .where(eq(productionItems.pillarContentItemId, pillar.id));
    const createdFormats = repurposed.map((r) => r.format);

    // Non-clippable child crossed its threshold → repurposed Idea created.
    expect(createdFormats).toContain(normalChild.name);
    // Clippable child crossed the SAME threshold but is skipped — it's the
    // Clip Ideas queue's responsibility, not the repurpose sweep's.
    expect(createdFormats).not.toContain(clipChild.name);
  });
});
