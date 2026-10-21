import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { createTestFormat } from "@/test/factories";
import { cancelDraftRun, cancelSectionRun } from "./cancel";

const ids: string[] = [];
afterEach(async () => {
  if (ids.length) await db.delete(newsletterDrafts).where(inArray(newsletterDrafts.id, ids.splice(0)));
});

async function draft(values: Partial<typeof newsletterDrafts.$inferInsert>) {
  const fmt = await createTestFormat({ brand: "vitest-cancel" });
  const [row] = await db
    .insert(newsletterDrafts)
    .values({ brand: "vitest-cancel", formatId: fmt.id, windowStart: new Date(), windowEnd: new Date(), ...values })
    .returning({ id: newsletterDrafts.id });
  ids.push(row.id);
  return row.id;
}
const get = async (id: string) => (await db.select().from(newsletterDrafts).where(eq(newsletterDrafts.id, id)))[0];

describe("cancelling a paid newsletter run", () => {
  it("puts a first draft back to not-drafted, and a cancelled Redraft back to its existing issue", async () => {
    const fresh = await draft({ status: "drafting" });
    const redraft = await draft({ status: "drafting", sections: [{ key: "intro", markdown: "Hey!" }] });
    expect(await cancelDraftRun(fresh)).toBe(true);
    expect(await cancelDraftRun(redraft)).toBe(true);
    expect((await get(fresh)).status).toBe("idea");
    expect((await get(redraft)).status).toBe("ready");
    expect((await get(redraft)).sections).toEqual([{ key: "intro", markdown: "Hey!" }]);
    expect(await cancelDraftRun(fresh)).toBe(false); // not drafting any more
  });

  it("drops only the cancelled section from regenerating", async () => {
    const id = await draft({ status: "ready", regenerating: ["coffee", "eggs"] });
    expect(await cancelSectionRun(id, "coffee")).toBe(true);
    expect((await get(id)).regenerating).toEqual(["eggs"]);
    expect(await cancelSectionRun(id, "coffee")).toBe(false);
  });
});
