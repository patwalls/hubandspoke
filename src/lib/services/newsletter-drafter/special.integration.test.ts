import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, newsletterDrafts } from "@/lib/db/schema";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { createTestFormat } from "@/test/factories";
import { applySpecialAction, type SpecialDeps } from "./special";

const ids: string[] = [];
afterEach(async () => {
  if (ids.length) await db.delete(newsletterDrafts).where(inArray(newsletterDrafts.id, ids.splice(0)));
});

/** A Sunday Breakfast-shaped draft: its ad slot is "special". */
async function draft(values: Partial<typeof newsletterDrafts.$inferInsert> = {}) {
  const fmt = await createTestFormat({ brand: "vitest-special" });
  await db.update(formats).set({ newsletterTemplate: DEFAULT_TEMPLATES["sunday breakfast"] }).where(eq(formats.id, fmt.id));
  const [row] = await db
    .insert(newsletterDrafts)
    .values({ brand: "vitest-special", formatId: fmt.id, windowStart: new Date(), windowEnd: new Date(), status: "ready", ...values })
    .returning({ id: newsletterDrafts.id });
  ids.push(row.id);
  return row.id;
}
const get = async (id: string) => (await db.select().from(newsletterDrafts).where(eq(newsletterDrafts.id, id)))[0];

const calls: { sponsorCopy: string; instruction?: string | null; landingUrl: string | null }[] = [];
const deps: SpecialDeps = {
  rewriteSpecial: async (a) => {
    calls.push({ sponsorCopy: a.sponsorCopy, instruction: a.instruction, landingUrl: a.landingUrl });
    return { ok: true, copy: `OUR VOICE: ${a.sponsorCopy}` };
  },
};
const asana = { taskGid: "1", taskName: "Nov 1 ad", taskUrl: "https://app.asana.com/0/1", landingUrl: "https://lp.example/a", copyFrom: "subtask" as const };

describe("the newsletter ad (sponsor section)", () => {
  it("bumps the revision on every change, so the open editor re-seeds instead of autosaving the old copy back", async () => {
    const id = await draft({ specialCopy: "Old", specialOriginal: "Old", specialMode: "verbatim" });
    const before = (await get(id)).revision;
    expect(await applySpecialAction(id, { action: "rewrite" }, deps)).toEqual({ ok: true });
    const after = await get(id);
    expect(after.specialCopy).toBe("OUR VOICE: Old");
    expect(after.revision).toBe(before + 1);
  });

  it("pasted copy replaces the Asana ad: as written with its link, or written in our voice", async () => {
    const id = await draft({ specialCopy: "Asana copy", specialOriginal: "Asana copy", specialSource: asana });
    await applySpecialAction(id, { action: "paste", copy: "Try Acme today.", link: "https://acme.example" }, deps);
    let row = await get(id);
    expect(row.specialCopy).toBe("Try Acme today.\n\n**[Check it out HERE](https://acme.example)**");
    expect(row.specialSource).toBeNull(); // the Asana landing page would add a second CTA
    expect(row.specialMode).toBe("verbatim");

    await applySpecialAction(id, { action: "paste", copy: "Acme: a CRM for one-person shops", rewrite: true }, deps);
    row = await get(id);
    expect(row.specialCopy).toBe("OUR VOICE: Acme: a CRM for one-person shops");
    expect(row.specialOriginal).toBe("Acme: a CRM for one-person shops");
    // "Use as written" brings the pasted copy back.
    await applySpecialAction(id, { action: "verbatim" }, deps);
    expect((await get(id)).specialCopy).toBe("Acme: a CRM for one-person shops");
  });

  it("Make changes works on the ad as it is now; a drafter-written ad becomes the original", async () => {
    const id = await draft({ sections: [{ key: "special", markdown: "Grab the free guide." }] });
    calls.length = 0;
    await applySpecialAction(id, { action: "rewrite", instruction: "shorter", current: "Grab the free guide." }, deps);
    expect(calls[0]).toMatchObject({ sponsorCopy: "Grab the free guide.", instruction: "shorter" });
    const row = await get(id);
    expect(row.specialCopy).toBe("OUR VOICE: Grab the free guide.");
    expect(row.specialOriginal).toBe("Grab the free guide.");
  });

  it("swapping the link replaces the appended Asana CTA instead of adding a second one", async () => {
    const id = await draft({ specialCopy: "Asana copy", specialOriginal: "Asana copy", specialSource: asana });
    // `current` is the ad as the email shows it: the copy plus the CTA built from the landing page.
    await applySpecialAction(id, { action: "link", url: "https://lp.example/b", current: "Asana copy\n\n**[Check it out HERE](https://lp.example/a)**" }, deps);
    const row = await get(id);
    expect(row.specialCopy).toBe("Asana copy\n\n**[Check it out HERE](https://lp.example/b)**");
    expect(row.specialSource?.landingUrl).toBe("https://lp.example/b");
    expect(row.specialOriginal).toContain("https://lp.example/b");
    expect(row.specialOriginal).not.toContain("https://lp.example/a");
  });

  it("remove empties the slot (the email drops it) and keeps the copy so Put it back restores it", async () => {
    const id = await draft({ sections: [{ key: "intro", markdown: "Hey!" }, { key: "special", markdown: "Drafter's ad." }] });
    await applySpecialAction(id, { action: "remove" }, deps);
    let row = await get(id);
    expect(row.specialMode).toBe("removed");
    expect(row.specialCopy).toBeNull();
    expect(row.sections).toEqual([{ key: "intro", markdown: "Hey!" }, { key: "special", markdown: "" }]);
    await applySpecialAction(id, { action: "verbatim" }, deps);
    row = await get(id);
    expect(row.specialCopy).toBe("Drafter's ad.");
  });

  it("refuses a link that isn't a URL and a paste with nothing in it", async () => {
    const id = await draft({ specialCopy: "Copy" });
    expect(await applySpecialAction(id, { action: "link", url: "acme dot com", current: "Copy" }, deps)).toMatchObject({ ok: false, status: 400 });
    expect(await applySpecialAction(id, { action: "paste", copy: "  " }, deps)).toMatchObject({ ok: false, status: 400 });
  });
});
