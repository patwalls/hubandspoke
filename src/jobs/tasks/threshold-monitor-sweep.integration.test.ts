/**
 * Integration tests for threshold-monitor-sweep.
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
 *
 * Each test inserts its own format_channels (and format_trigger_sources for
 * root-format tests). Both cascade-delete when their parent format is cleaned
 * up by the factory's afterEach, so no explicit cleanup is needed.
 *
 * Tests use a 60s timeout because the sweep scans all published items in
 * the dev DB (pulled from production) on every run.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { and, eq, inArray } from "drizzle-orm";

// Hoisted before the module under test is imported.
vi.mock("@/jobs/enqueue", () => ({
  enqueue: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/services/item-created", () => ({
  recordItemCreated: vi.fn().mockResolvedValue(undefined),
}));

import { thresholdMonitorSweepTask } from "./threshold-monitor-sweep";
import { db } from "@/lib/db";
import {
  productionItems,
  repurposeTriggers,
  formatTriggerSources,
  formatChannels,
} from "@/lib/db/schema";
import {
  createTestFormat,
  createTestProductionItem,
  getTestAccountId,
} from "@/test/factories";

const SWEEP_TIMEOUT = 60_000;

function fakeHelpers() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as Parameters<typeof thresholdMonitorSweepTask>[1];
}

// Sweep-created rows (NOT tracked by the factory) — purged in afterEach.
let preItemIds: Set<string> = new Set();
let preTriggerIds: Set<string> = new Set();

beforeEach(() => {
  // Set TRIGGER_ROUTING_MIN_PUBLISHED_AT to 2 minutes ago so test fixtures
  // (publishedAt = now) are eligible while the historical production catalog
  // is excluded, keeping each sweep run fast.
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  vi.stubEnv("TRIGGER_ROUTING_MIN_PUBLISHED_AT", twoMinutesAgo);
});

afterEach(async () => {
  vi.unstubAllEnvs();

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
  it("creates a repurposed Idea for a non-clippable derivative but skips the clippable one", async () => {
    const suffix = `${Date.now()}`;
    const testAccountId = await getTestAccountId();

    const parent = await createTestFormat({ name: `vitest-parent-${suffix}` });
    // Derivatives route via parent's format_channels — add the test account.
    // Default postType from createTestProductionItem is "x".
    await db.insert(formatChannels).values({
      formatId: parent.id,
      accountId: testAccountId,
      postType: "x",
    });

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

    // Pillar on the test account, views > threshold.
    const pillar = await createTestProductionItem({
      status: "Published",
      views: 50_000,
      // postType defaults to "x", accountId defaults to testAccountId
    });

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

    // Non-clippable derivative crossed its threshold → repurposed Idea created.
    expect(createdFormats).toContain(normalChild.name);
    // Clippable derivative crossed the SAME threshold but is skipped.
    expect(createdFormats).not.toContain(clipChild.name);
  }, SWEEP_TIMEOUT);
});

describe("thresholdMonitorSweepTask — derivative routing via parent channels", () => {
  it("triggers only items whose postType matches the parent's channel mapping", async () => {
    const suffix = `${Date.now()}`;
    const testAccountId = await getTestAccountId();

    const parent = await createTestFormat({ name: `vitest-parent-${suffix}` });
    await db.insert(formatChannels).values({
      formatId: parent.id,
      accountId: testAccountId,
      postType: "youtube_long",
    });

    const child = await createTestFormat({
      name: `vitest-child-${suffix}`,
      parentFormatId: parent.id,
      isClippableFormat: false,
      viewThreshold: 1000,
    });

    const longPillar = await createTestProductionItem({
      status: "Published",
      views: 50_000,
      postType: "youtube_long",
    });
    const shortPillar = await createTestProductionItem({
      status: "Published",
      views: 50_000,
      postType: "youtube_short",
    });

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

    const longTriggered = await db
      .select({ id: productionItems.id })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.pillarContentItemId, longPillar.id),
          eq(productionItems.format, child.name),
        ),
      );
    const shortTriggered = await db
      .select({ id: productionItems.id })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.pillarContentItemId, shortPillar.id),
          eq(productionItems.format, child.name),
        ),
      );

    // Long-form matches the parent's channel mapping → trigger created.
    expect(longTriggered).toHaveLength(1);
    // Short does not match → blocked.
    expect(shortTriggered).toHaveLength(0);
  }, SWEEP_TIMEOUT);

  it("never triggers when the parent has no channel for the source account", async () => {
    const suffix = `${Date.now()}`;
    const testAccountId = await getTestAccountId();

    // Parent has NO format_channels — derivative can never trigger.
    const parent = await createTestFormat({ name: `vitest-parent-${suffix}` });
    const child = await createTestFormat({
      name: `vitest-child-${suffix}`,
      parentFormatId: parent.id,
      isClippableFormat: false,
      viewThreshold: 1000,
    });

    // A format_trigger_sources entry for the child — must NOT broaden eligibility.
    await db.insert(formatTriggerSources).values({
      formatId: child.id,
      sourceAccountId: testAccountId,
    });

    const pillar = await createTestProductionItem({
      status: "Published",
      views: 50_000,
    });

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

    const triggered = await db
      .select({ id: productionItems.id })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.pillarContentItemId, pillar.id),
          eq(productionItems.format, child.name),
        ),
      );

    // format_trigger_sources cannot override parent channel routing — no trigger.
    expect(triggered).toHaveLength(0);
  }, SWEEP_TIMEOUT);

  it("root formats without a parent still use format_trigger_sources", async () => {
    const suffix = `${Date.now()}`;
    const testAccountId = await getTestAccountId();

    // Root format (no parentFormatId) — uses format_trigger_sources.
    const rootFormat = await createTestFormat({
      name: `vitest-root-${suffix}`,
      isClippableFormat: false,
      viewThreshold: 1000,
    });
    await db.insert(formatTriggerSources).values({
      formatId: rootFormat.id,
      sourceAccountId: testAccountId,
    });

    const pillar = await createTestProductionItem({
      status: "Published",
      views: 50_000,
    });

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

    const triggered = await db
      .select({ id: productionItems.id })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.pillarContentItemId, pillar.id),
          eq(productionItems.format, rootFormat.name),
        ),
      );

    // Root format with trigger source and views above threshold → triggered.
    expect(triggered).toHaveLength(1);
  }, SWEEP_TIMEOUT);
});
