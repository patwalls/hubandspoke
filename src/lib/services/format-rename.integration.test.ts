/**
 * Integration tests for the format-rename cascade. The whole point is that a
 * format's NAME is the string key production_items + clip_ideas link to, so a
 * rename must carry every referencing row with it — and ONLY the rows on that
 * format's brand. The cross-brand isolation case is the one that matters most:
 * "X Quotables" exists on multiple brands, so an unscoped rewrite would corrupt
 * the wrong brand's rows.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, productionItems } from "@/lib/db/schema";
import {
  cascadeFormatRename,
  countFormatRenameImpact,
} from "./format-rename";
import { createTestProductionItem, createTestClipIdea } from "@/test/factories";

const uniq = () => `vitest-rename-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describe("cascadeFormatRename", () => {
  it("rewrites production_items.format on the brand", async () => {
    const brand = uniq();
    const oldName = `Old ${uniq()}`;
    const newName = `New ${uniq()}`;
    const item = await createTestProductionItem({ brand, format: oldName, accountId: null });

    await db.transaction((tx) =>
      cascadeFormatRename(tx, { brand, oldName, newName }),
    );

    const [after] = await db
      .select({ format: productionItems.format })
      .from(productionItems)
      .where(eq(productionItems.id, item.id));
    expect(after.format).toBe(newName);
  });

  it("rewrites clip_ideas.target_format and accepted_target_format via the source item's brand", async () => {
    const brand = uniq();
    const oldName = `Old ${uniq()}`;
    const newName = `New ${uniq()}`;
    const source = await createTestProductionItem({ brand, format: oldName, accountId: null });
    const idea = await createTestClipIdea({
      sourceProductionItemId: source.id,
      targetFormat: oldName,
      acceptedTargetFormat: oldName,
    });

    await db.transaction((tx) =>
      cascadeFormatRename(tx, { brand, oldName, newName }),
    );

    const [after] = await db
      .select({
        targetFormat: clipIdeas.targetFormat,
        acceptedTargetFormat: clipIdeas.acceptedTargetFormat,
      })
      .from(clipIdeas)
      .where(eq(clipIdeas.id, idea.id));
    expect(after.targetFormat).toBe(newName);
    expect(after.acceptedTargetFormat).toBe(newName);
  });

  it("does NOT touch another brand's rows that share the same format name", async () => {
    const sharedName = `Shared ${uniq()}`;
    const newName = `New ${uniq()}`;
    const brandA = uniq();
    const brandB = uniq();

    const itemA = await createTestProductionItem({ brand: brandA, format: sharedName, accountId: null });
    const itemB = await createTestProductionItem({ brand: brandB, format: sharedName, accountId: null });
    const ideaB = await createTestClipIdea({
      sourceProductionItemId: itemB.id,
      targetFormat: sharedName,
    });

    // Rename only on brandA.
    await db.transaction((tx) =>
      cascadeFormatRename(tx, { brand: brandA, oldName: sharedName, newName }),
    );

    const [a] = await db
      .select({ format: productionItems.format })
      .from(productionItems)
      .where(eq(productionItems.id, itemA.id));
    const [b] = await db
      .select({ format: productionItems.format })
      .from(productionItems)
      .where(eq(productionItems.id, itemB.id));
    const [cb] = await db
      .select({ targetFormat: clipIdeas.targetFormat })
      .from(clipIdeas)
      .where(eq(clipIdeas.id, ideaB.id));

    expect(a.format).toBe(newName); // brandA renamed
    expect(b.format).toBe(sharedName); // brandB untouched
    expect(cb.targetFormat).toBe(sharedName); // brandB clip idea untouched
  });

  it("returns the count of rows actually changed", async () => {
    const brand = uniq();
    const oldName = `Old ${uniq()}`;
    const newName = `New ${uniq()}`;
    const source = await createTestProductionItem({ brand, format: oldName, accountId: null });
    await createTestClipIdea({ sourceProductionItemId: source.id, targetFormat: oldName });
    await createTestClipIdea({ sourceProductionItemId: source.id, targetFormat: oldName });

    const impact = await db.transaction((tx) =>
      cascadeFormatRename(tx, { brand, oldName, newName }),
    );
    expect(impact.productionItems).toBe(1);
    expect(impact.clipIdeas).toBe(2);
  });
});

describe("countFormatRenameImpact", () => {
  it("counts referencing rows on the brand without mutating anything", async () => {
    const brand = uniq();
    const name = `Counted ${uniq()}`;
    const source = await createTestProductionItem({ brand, format: name, accountId: null });
    await createTestClipIdea({ sourceProductionItemId: source.id, targetFormat: name });
    await createTestClipIdea({
      sourceProductionItemId: source.id,
      acceptedTargetFormat: name,
    });

    const impact = await countFormatRenameImpact({ brand, name });
    expect(impact.productionItems).toBe(1);
    expect(impact.clipIdeas).toBe(2);

    // Confirm it was a pure read — the name is unchanged.
    const [still] = await db
      .select({ format: productionItems.format })
      .from(productionItems)
      .where(eq(productionItems.id, source.id));
    expect(still.format).toBe(name);
  });
});
