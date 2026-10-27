import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { newsletterDrafts } from "@/lib/db/schema";
import { templateFor } from "@/lib/newsletter-template";
import { createTestFormat } from "@/test/factories";
import { revisableKeys, reviseDraft, startRevision } from "./revise";

// Pat, 2026-10-27: the newsletter writer wanted one Revise for the whole email,
// not only per-section rewrites. The note becomes per-section rewrites for just
// the sections it touches; the rest (and the ad) are left alone.
const FORMAT = "Sunday Breakfast"; // built-in template, under a throwaway brand
const keys = revisableKeys(templateFor(FORMAT, null)!);

const drafts: string[] = [];
afterEach(async () => {
  if (drafts.length) await db.delete(newsletterDrafts).where(inArray(newsletterDrafts.id, drafts.splice(0)));
});

async function readyDraft() {
  const fmt = await createTestFormat({ brand: "vitest-revise", name: FORMAT });
  const now = new Date();
  const [d] = await db
    .insert(newsletterDrafts)
    .values({ brand: "vitest-revise", formatId: fmt.id, status: "ready", windowStart: now, windowEnd: now, sections: keys.map((k) => ({ key: k, markdown: `text of ${k}` })) })
    .returning({ id: newsletterDrafts.id });
  drafts.push(d.id);
  return d.id;
}
const plan = (input: unknown) =>
  ({ messages: { create: async () => ({ content: [{ type: "tool_use", id: "t", name: "submit_revision_plan", input }] }) } }) as unknown as Anthropic;
const rowOf = async (id: string) => (await db.select().from(newsletterDrafts).where(eq(newsletterDrafts.id, id)))[0];

describe("whole-email Revise", () => {
  it("holds every revisable section, then hands only the touched ones to their section rewrite", async () => {
    const id = await readyDraft();
    expect(await startRevision(id)).toEqual(keys);
    expect((await rowOf(id)).regenerating.sort()).toEqual([...keys].sort());

    const queued: { key: string; instruction: string }[] = [];
    const r = await reviseDraft(id, "the pitch should say it's free", {
      client: plan({ edits: [{ section_key: keys[1], instruction: "Say it's free." }] }),
      enqueueSection: async (key, instruction) => void queued.push({ key, instruction }),
    });
    expect(r).toEqual({ ok: true, revised: [keys[1]] });
    expect(queued.map((q) => q.key)).toEqual([keys[1]]);
    expect(queued[0].instruction).toContain("Say it's free.");
    // The touched section stays held for its rewrite job; the rest are released.
    expect((await rowOf(id)).regenerating).toEqual([keys[1]]);
  });

  it("a section cancelled while the plan ran stays cancelled", async () => {
    const id = await readyDraft();
    await startRevision(id);
    await db.update(newsletterDrafts).set({ regenerating: keys.filter((k) => k !== keys[0]) }).where(eq(newsletterDrafts.id, id));
    const queued: string[] = [];
    await reviseDraft(id, "shorter everywhere", {
      client: plan({ edits: keys.map((k) => ({ section_key: k, instruction: "Shorter." })) }),
      enqueueSection: async (key) => void queued.push(key),
    });
    expect(queued).toEqual(keys.slice(1));
  });

  it("a failed plan releases every section and says why", async () => {
    const id = await readyDraft();
    await startRevision(id);
    const r = await reviseDraft(id, "x", { client: plan({ nope: 1 }), enqueueSection: async () => {} });
    expect(r.ok).toBe(false);
    const row = await rowOf(id);
    expect(row.regenerating).toEqual([]);
    expect(row.error).toMatch(/^Revise failed/);
  });

  it("won't start on a draft that isn't ready", async () => {
    const id = await readyDraft();
    await db.update(newsletterDrafts).set({ status: "drafting" }).where(eq(newsletterDrafts.id, id));
    expect(await startRevision(id)).toBeNull();
  });
});
