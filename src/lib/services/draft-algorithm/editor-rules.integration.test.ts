import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import {
  createTestContentDraft,
  createTestFormat,
  createTestProductionItem,
} from "@/test/factories";
import { MIN_PAIRS, refreshEditorRules } from "./editor-rules";

async function rewrite(format: string, n: number) {
  const item = await createTestProductionItem({ format, status: "Published" });
  await createTestContentDraft({
    productionItemId: item.id,
    version: 1,
    isCurrent: false,
    generatedBy: "draft-algo:v1.7:test:v17",
    content: { caption: `He built an app ${n}. It makes money.` },
  });
  await createTestContentDraft({
    productionItemId: item.id,
    version: 2,
    isCurrent: true,
    generatedBy: "user:edit",
    content: { caption: `Sam built an app ${n}.\n\nIt makes money.` },
  });
}

const rulesOf = async (id: string) =>
  (await db.select({ r: formats.editorRules }).from(formats).where(eq(formats.id, id)))[0].r;

describe("refreshEditorRules", () => {
  it("writes rules for a format with enough rewrites, and leaves fresh or thin ones alone", async () => {
    const now = new Date();
    const busy = await createTestFormat();
    const thin = await createTestFormat();
    const fresh = await createTestFormat({
      editorRules: { rules: ["Keep me."], pairCount: 5, generatedAt: now.toISOString(), model: "m" },
    });
    for (let i = 0; i < MIN_PAIRS; i++) {
      await rewrite(busy.name, i);
      await rewrite(fresh.name, i);
    }
    await rewrite(thin.name, 0);

    const seen: string[] = [];
    const summary = await refreshEditorRules({
      now,
      formatIds: [busy.id, thin.id, fresh.id],
      summarize: async (pairs, format) => {
        seen.push(format);
        expect(pairs).toHaveLength(MIN_PAIRS);
        return { ok: true, rules: ["Open with the founder's name."] };
      },
    });

    expect(seen).toEqual([busy.name]);
    expect(summary).toMatchObject({ formats: 3, updated: 1, skipped: 2, failed: 0 });
    expect(await rulesOf(busy.id)).toMatchObject({ rules: ["Open with the founder's name."], pairCount: MIN_PAIRS });
    expect(await rulesOf(thin.id)).toBeNull();
    expect((await rulesOf(fresh.id))?.rules).toEqual(["Keep me."]);
  });

  it("keeps last week's rules when the model call fails", async () => {
    const old = { rules: ["Old rule."], pairCount: 6, generatedAt: "2026-01-01T00:00:00Z", model: "m" };
    const fmt = await createTestFormat({ editorRules: old });
    for (let i = 0; i < MIN_PAIRS; i++) await rewrite(fmt.name, i);
    const summary = await refreshEditorRules({
      formatIds: [fmt.id],
      summarize: async () => ({ ok: false, failure: "boom" }),
    });
    expect(summary.failed).toBe(1);
    expect(await rulesOf(fmt.id)).toEqual(old);
  });
});
