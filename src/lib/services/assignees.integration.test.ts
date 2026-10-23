import { describe, expect, it } from "vitest";
import { createTestProductionItem, getTestUserId } from "@/test/factories";
import { resolveEditor } from "./assignees";

describe("resolveEditor", () => {
  it("leaves an item unassigned when nothing in the chain has an owner", async () => {
    // Until 2026-10-23 this fell back to Pat, which put 2,264 clip ideas he
    // never worked on in his name.
    expect(await resolveEditor({ brand: "vitest-no-such-brand", format: "vitest-no-such-format" })).toBeNull();
  });

  it("an unassigned source item hands down no owner", async () => {
    const pillar = await createTestProductionItem({ brand: "vitest-no-such-brand", accountId: null, editorUserId: null });
    expect(pillar.editorUserId).toBeNull();
    expect(await resolveEditor({ brand: "vitest-no-such-brand", sourceItemId: pillar.id })).toBeNull();
  });

  it("still inherits the source item's owner", async () => {
    const me = await getTestUserId();
    const pillar = await createTestProductionItem({ editorUserId: me });
    expect(await resolveEditor({ brand: pillar.brand, sourceItemId: pillar.id })).toBe(me);
  });
});
