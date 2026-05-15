import { describe, expect, it } from "vitest";

import { assertCompositionUnique } from "./descript-composition";
import { createTestProductionItem } from "@/test/factories";

describe("assertCompositionUnique", () => {
  it("passes when the composition isn't on any other row", async () => {
    const item = await createTestProductionItem();
    await expect(
      assertCompositionUnique({
        compositionId: `unique-${item.id}`,
        intendedItemId: item.id,
      }),
    ).resolves.toBeUndefined();
  });

  it("passes when the composition is already on the intended row itself", async () => {
    // Idempotency: writing the same composition to the same row should not
    // be flagged. The pre-check is for cross-row collisions, not re-runs of
    // the same write.
    const compositionId = `comp-${Date.now()}`;
    const item = await createTestProductionItem({
      descriptCompositionId: compositionId,
    });
    await expect(
      assertCompositionUnique({
        compositionId,
        intendedItemId: item.id,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when the composition is already on a different row", async () => {
    const compositionId = `comp-collide-${Date.now()}`;
    const existing = await createTestProductionItem({
      descriptCompositionId: compositionId,
    });
    const target = await createTestProductionItem();
    await expect(
      assertCompositionUnique({
        compositionId,
        intendedItemId: target.id,
      }),
    ).rejects.toThrow(
      new RegExp(
        `composition ${compositionId} is already attached to production_item ${existing.id}`,
      ),
    );
  });
});
