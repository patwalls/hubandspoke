/**
 * The first open's AI draft runs on the worker, not in the request: it took
 * 15–25s+ and a slow run crossed Heroku's 30s router limit, dropping the
 * editor to the classic view with no message (2026-10-14).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designDocs } from "@/lib/db/schema";
import { createTestFormat, createTestProductionItem, getTestUserId } from "@/test/factories";
import { buildPlaybookTemplate } from "@/lib/design-editor/playbook-template";

const enqueue = vi.fn();
vi.mock("@/jobs/enqueue", () => ({ enqueue: (...args: unknown[]) => enqueue(...args) }));
const { loadDesignEditorSession, requestDesignRegenerate, designDraftJobKey, DesignUnsupportedError } = await import("./session");

beforeEach(() => enqueue.mockReset());

async function draftableItem() {
  const format = await createTestFormat({ designTemplate: buildPlaybookTemplate() });
  const item = await createTestProductionItem({ status: "Idea", sourceType: "repurposed", postType: "instagram_post", format: format.name });
  return { item, userId: await getTestUserId() };
}

describe("loadDesignEditorSession — first open", () => {
  it("queues the draft once on the worker and answers 'drafting' instead of drafting in the request", async () => {
    const { item, userId } = await draftableItem();
    const res = await loadDesignEditorSession({ productionItemId: item.id, userId });
    expect(res).toEqual({ drafting: true });
    expect(enqueue).toHaveBeenCalledWith(
      "design-draft",
      { productionItemId: item.id, userId },
      expect.objectContaining({ jobKey: designDraftJobKey(item.id), jobKeyMode: "unsafe_dedupe", maxAttempts: 3 }),
    );
  });

  it("reports a failed draft once, then clears it so the next open retries", async () => {
    const { item, userId } = await draftableItem();
    const key = designDraftJobKey(item.id);
    await db.execute(sql`SELECT graphile_worker.add_job('design-draft', '{}'::json, job_key := ${key}, max_attempts := 1, run_at := now() + interval '1 day')`);
    await db.execute(sql`UPDATE graphile_worker._private_jobs SET attempts = 1, last_error = 'The source video has no transcript yet' WHERE key = ${key}`);
    try {
      const err = await loadDesignEditorSession({ productionItemId: item.id, userId }).catch((e) => e);
      expect(err).toBeInstanceOf(DesignUnsupportedError);
      expect(err.message).toBe("The source video has no transcript yet");
      expect(enqueue).not.toHaveBeenCalledWith("design-draft", expect.anything(), expect.anything());

      const left = await db.execute(sql`SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE key = ${key}`);
      expect((left as unknown as Array<{ n: number }>)[0].n).toBe(0);
    } finally {
      await db.execute(sql`SELECT graphile_worker.remove_job(${key})`);
    }
  });

  // Graphile bumps attempts when it picks a job up: a running single-try job
  // reads attempts = max_attempts. That read as "failed" 2s in while the
  // draft went on to succeed (2026-10-14).
  it("keeps polling while the worker is still running its last try", async () => {
    const { item, userId } = await draftableItem();
    const key = designDraftJobKey(item.id);
    await db.execute(sql`SELECT graphile_worker.add_job('design-draft', '{}'::json, job_key := ${key}, max_attempts := 1, run_at := now() + interval '1 day')`);
    await db.execute(sql`UPDATE graphile_worker._private_jobs SET attempts = 1, locked_at = now(), locked_by = 'test-worker' WHERE key = ${key}`);
    try {
      const res = await loadDesignEditorSession({ productionItemId: item.id, userId });
      expect(res).toEqual({ drafting: true });
    } finally {
      await db.execute(sql`DELETE FROM graphile_worker._private_jobs WHERE key = ${key}`);
    }
  });

  it("says why even when the failed job recorded no error", () => {
    expect(DesignUnsupportedError.draftFailed(null, 3).message).toMatch(/tried 3 times.*without recording an error/);
    expect(DesignUnsupportedError.draftFailed("Error: 529 overloaded\n    at stack", 3).message).toBe("The AI couldn't draft this post (tried 3 times): Error: 529 overloaded");
  });

  it("opens the document once the worker has written it", async () => {
    const { item, userId } = await draftableItem();
    await db.insert(designDocs).values({ productionItemId: item.id, doc: buildPlaybookTemplate(), brief: { caption: "", values: [] } });
    try {
      const res = await loadDesignEditorSession({ productionItemId: item.id, userId });
      expect("drafting" in res).toBe(false);
    } finally {
      await db.execute(sql`DELETE FROM design_docs WHERE production_item_id = ${item.id}`);
    }
  });
});

// Regenerate moved to the worker too (2026-10-16): the fill may web-search
// the founder, which outlasts the router. Same key, so one AI run per item.
describe("regenerate — on the worker", () => {
  it("queues the re-draft with the instruction and answers 'drafting'", async () => {
    const { item, userId } = await draftableItem();
    await db.insert(designDocs).values({ productionItemId: item.id, doc: buildPlaybookTemplate(), brief: { caption: "", values: [] } });
    try {
      const res = await requestDesignRegenerate({ productionItemId: item.id, instruction: "lead with the Reddit moment", userId });
      expect(res).toEqual({ drafting: true });
      expect(enqueue).toHaveBeenCalledWith(
        "design-draft",
        { productionItemId: item.id, userId, regenerate: true, instruction: "lead with the Reddit moment" },
        { jobKey: designDraftJobKey(item.id), jobKeyMode: "unsafe_dedupe", maxAttempts: 3 },
      );
    } finally {
      await db.execute(sql`DELETE FROM design_docs WHERE production_item_id = ${item.id}`);
    }
  });

  it("answers 'drafting' on open while the re-draft runs, even though a document exists", async () => {
    const { item, userId } = await draftableItem();
    const key = designDraftJobKey(item.id);
    await db.insert(designDocs).values({ productionItemId: item.id, doc: buildPlaybookTemplate(), brief: { caption: "", values: [] } });
    await db.execute(sql`SELECT graphile_worker.add_job('design-draft', '{}'::json, job_key := ${key}, max_attempts := 3, run_at := now() + interval '1 day')`);
    try {
      expect(await loadDesignEditorSession({ productionItemId: item.id, userId })).toEqual({ drafting: true });
      // A second Regenerate while one runs doesn't queue another.
      expect(await requestDesignRegenerate({ productionItemId: item.id, instruction: null, userId })).toEqual({ drafting: true });
      expect(enqueue).not.toHaveBeenCalledWith("design-draft", expect.anything(), expect.anything());
    } finally {
      await db.execute(sql`SELECT graphile_worker.remove_job(${key})`);
      await db.execute(sql`DELETE FROM design_docs WHERE production_item_id = ${item.id}`);
    }
  });

  it("reports a failed re-draft once on open, then the document opens again", async () => {
    const { item, userId } = await draftableItem();
    const key = designDraftJobKey(item.id);
    await db.insert(designDocs).values({ productionItemId: item.id, doc: buildPlaybookTemplate(), brief: { caption: "", values: [] } });
    await db.execute(sql`SELECT graphile_worker.add_job('design-draft', '{}'::json, job_key := ${key}, max_attempts := 1, run_at := now() + interval '1 day')`);
    await db.execute(sql`UPDATE graphile_worker._private_jobs SET attempts = 1, last_error = 'The model declined this request' WHERE key = ${key}`);
    try {
      const err = await loadDesignEditorSession({ productionItemId: item.id, userId }).catch((e) => e);
      expect(err).toBeInstanceOf(DesignUnsupportedError);
      expect(err.message).toBe("The model declined this request");
      const again = await loadDesignEditorSession({ productionItemId: item.id, userId });
      expect("drafting" in again).toBe(false);
    } finally {
      await db.execute(sql`SELECT graphile_worker.remove_job(${key})`);
      await db.execute(sql`DELETE FROM design_docs WHERE production_item_id = ${item.id}`);
    }
  });
});
