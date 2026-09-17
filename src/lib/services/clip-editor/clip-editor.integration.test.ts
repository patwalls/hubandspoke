/**
 * Integration tests for the clip editor's DB-touching services. The contract
 * under test is "a clip exported here is indistinguishable, downstream, from
 * one promoted through Descript" — so these assert the workflow side effects
 * (item status, idea status, render rows, media slot 0), not the pixels.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipIdeas,
  clipRenders,
  contentComments,
  productionItemMedia,
  productionItems,
} from "@/lib/db/schema";
import {
  createTestClipEdit,
  createTestClipIdea,
  createTestMedia,
  createTestProductionItem,
  getTestUserId,
} from "@/test/factories";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import { addRemoval } from "@/lib/clip-editor/removals";
import { ClipIdeaAlreadyDecidedError } from "@/lib/services/promote-clip-idea";

const enqueue = vi.fn();
vi.mock("@/jobs/enqueue", () => ({ enqueue: (...args: unknown[]) => enqueue(...args) }));

// Imported after the mock so the services bind to the mocked enqueue.
const { exportClipEdit, buildClipCreatedComment, ClipEditEmptyError, ClipEditNotFoundError } =
  await import("./export");
const { installRenderedClipMedia, CLIP_EDITOR_SOURCE_PREFIX } = await import("./install-rendered-media");
const { saveClipEdit } = await import("./save");
const { toRenderStatus, RENDER_STALL_MS } = await import("./render-status");

beforeEach(() => enqueue.mockReset());

/** A pillar with media + a suggested idea + the queue-side item generated
 *  for it — the state every idea in the real queue is in. */
async function seedIdea(opts: { status?: string } = {}) {
  const pillar = await createTestProductionItem({
    postType: "youtube_long",
    mediaS3Bucket: "vitest-bucket",
    mediaS3Key: "vitest/pillar.mp4",
  });
  const idea = await createTestClipIdea({
    sourceProductionItemId: pillar.id,
    startSec: 100,
    endSec: 130,
    hook: "original hook",
    status: opts.status ?? "suggested",
  });
  const queueItem = await createTestProductionItem({
    status: "Idea",
    sourceType: "repurposed",
    sourceClipIdeaId: idea.id,
    postType: "instagram_reel",
  });
  return { pillar, idea, queueItem };
}

describe("exportClipEdit", () => {
  it("promotes the idea exactly like a Descript promotion, and queues one render", async () => {
    const userId = await getTestUserId();
    const { idea, queueItem } = await seedIdea();
    const doc = createDefaultDoc({ startSec: 100, endSec: 130, hook: "edited hook" });
    const edit = await createTestClipEdit({ clipIdeaId: idea.id, doc });

    const result = await exportClipEdit({ clipIdeaId: idea.id, actorUserId: userId });

    expect(result).toMatchObject({ productionItemId: queueItem.id, reExport: false });
    const [item] = await db.select().from(productionItems).where(eq(productionItems.id, queueItem.id));
    expect(item).toMatchObject({ status: "Assigned", editorUserId: userId, title: "edited hook", hook: "edited hook" });
    const [after] = await db.select().from(clipIdeas).where(eq(clipIdeas.id, idea.id));
    expect(after).toMatchObject({ status: "assigned", acceptedProductionItemId: queueItem.id, hook: "edited hook" });

    const renders = await db.select().from(clipRenders).where(eq(clipRenders.clipEditId, edit.id));
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({ status: "queued", productionItemId: queueItem.id });
    expect(renders[0].doc).toEqual(doc); // snapshot, not a reference to the live edit

    expect(enqueue).toHaveBeenCalledWith(
      "clip-render",
      { renderId: renders[0].id },
      expect.objectContaining({ jobKey: `clip-render:${edit.id}`, queueName: "media-heavy" }),
    );
    expect(enqueue).toHaveBeenCalledWith("draft-algorithm-run", { productionItemId: queueItem.id });

    // One terse activity comment: range + hook, none of the Descript paths'
    // rationale / transcript dump.
    const comments = await db
      .select({ body: contentComments.body, userId: contentComments.userId })
      .from(contentComments)
      .where(eq(contentComments.contentItemId, queueItem.id));
    expect(comments).toHaveLength(1);
    expect(comments[0].userId).toBe(userId);
    expect(comments[0].body).toContain("Created a clip from the queue");
    expect(comments[0].body).toContain("01:40–02:10</strong> (30s)");
    expect(comments[0].body).toContain("<blockquote>edited hook</blockquote>");
    expect(comments[0].body).not.toMatch(/viral|Transcript|vitest rationale/i);
  });

  it("the comment reports what PLAYS after cuts, and escapes the hook", async () => {
    const d = createDefaultDoc({ startSec: 100, endSec: 130, hook: "x" });
    d.sections[0] = addRemoval(d.sections[0], { startSec: 110, endSec: 120 }, "manual");
    const body = buildClipCreatedComment(d, `5 < 6 & "quotes"`);
    expect(body).toContain("01:40–02:10</strong> (20s)");
    expect(body).toContain("5 &lt; 6 &amp; &quot;quotes&quot;");
  });

  it("re-export supersedes the in-flight render and skips the one-time promotion steps", async () => {
    const userId = await getTestUserId();
    const { idea } = await seedIdea();
    const edit = await createTestClipEdit({ clipIdeaId: idea.id });
    await exportClipEdit({ clipIdeaId: idea.id, actorUserId: userId });
    enqueue.mockReset();

    const second = await exportClipEdit({ clipIdeaId: idea.id, actorUserId: userId });

    expect(second.reExport).toBe(true);
    const renders = await db
      .select({ status: clipRenders.status })
      .from(clipRenders)
      .where(eq(clipRenders.clipEditId, edit.id))
      .orderBy(asc(clipRenders.createdAt));
    expect(renders.map((r) => r.status)).toEqual(["superseded", "queued"]);
    expect(enqueue).toHaveBeenCalledTimes(1); // render only — no second draft-algorithm-run
    expect(enqueue.mock.calls[0][0]).toBe("clip-render");
  });

  it("refuses an idea that was decided outside the editor", async () => {
    const userId = await getTestUserId();
    const { idea } = await seedIdea({ status: "assigned" }); // e.g. promoted via Descript
    await createTestClipEdit({ clipIdeaId: idea.id });
    await expect(exportClipEdit({ clipIdeaId: idea.id, actorUserId: userId })).rejects.toBeInstanceOf(
      ClipIdeaAlreadyDecidedError,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses an edit with no footage left BEFORE touching the workflow", async () => {
    const userId = await getTestUserId();
    const { idea, queueItem } = await seedIdea();
    const doc = createDefaultDoc({ startSec: 100, endSec: 130, hook: "h" });
    doc.sections[0] = addRemoval(doc.sections[0], { startSec: 100, endSec: 130 }, "manual");
    await createTestClipEdit({ clipIdeaId: idea.id, doc });

    await expect(exportClipEdit({ clipIdeaId: idea.id, actorUserId: userId })).rejects.toBeInstanceOf(
      ClipEditEmptyError,
    );
    const [item] = await db.select().from(productionItems).where(eq(productionItems.id, queueItem.id));
    expect(item.status).toBe("Idea");
  });

  it("404s an idea that was never opened in the editor", async () => {
    const userId = await getTestUserId();
    const { idea } = await seedIdea();
    await expect(exportClipEdit({ clipIdeaId: idea.id, actorUserId: userId })).rejects.toBeInstanceOf(
      ClipEditNotFoundError,
    );
  });
});

describe("installRenderedClipMedia", () => {
  const mediaOf = (itemId: string) =>
    db
      .select({ index: productionItemMedia.index, s3Key: productionItemMedia.s3Key, sourceUrl: productionItemMedia.sourceUrl })
      .from(productionItemMedia)
      .where(eq(productionItemMedia.productionItemId, itemId))
      .orderBy(asc(productionItemMedia.index));

  it("takes index 0, pushes existing media down, and mirrors the legacy cover columns", async () => {
    const item = await createTestProductionItem({});
    await createTestMedia({ productionItemId: item.id, index: 0, s3Key: "vitest/manual-a.mp4" });
    await createTestMedia({ productionItemId: item.id, index: 1, s3Key: "vitest/manual-b.mp4" });

    await installRenderedClipMedia({
      productionItemId: item.id, renderId: "r1", s3Bucket: "vitest-bucket", s3Key: "vitest/render-1.mp4", sizeBytes: 10,
    });

    expect((await mediaOf(item.id)).map((m) => m.s3Key)).toEqual([
      "vitest/render-1.mp4", "vitest/manual-a.mp4", "vitest/manual-b.mp4",
    ]);
    const [row] = await db.select().from(productionItems).where(eq(productionItems.id, item.id));
    expect(row.mediaS3Key).toBe("vitest/render-1.mp4");
  });

  it("a re-export replaces the previous render but never a manual upload", async () => {
    const item = await createTestProductionItem({});
    await createTestMedia({ productionItemId: item.id, index: 0, s3Key: "vitest/manual.mp4" });
    const args = { productionItemId: item.id, s3Bucket: "vitest-bucket", sizeBytes: 10 };
    await installRenderedClipMedia({ ...args, renderId: "r1", s3Key: "vitest/render-1.mp4" });
    await installRenderedClipMedia({ ...args, renderId: "r2", s3Key: "vitest/render-2.mp4" });

    const media = await mediaOf(item.id);
    expect(media.map((m) => m.s3Key)).toEqual(["vitest/render-2.mp4", "vitest/manual.mp4"]);
    expect(media.map((m) => m.index)).toEqual([0, 1]);
    expect(media[0].sourceUrl).toBe(`${CLIP_EDITOR_SOURCE_PREFIX}r2`);
  });

  it("is idempotent — a retried job does not insert a second row", async () => {
    const item = await createTestProductionItem({});
    const args = { productionItemId: item.id, renderId: "r1", s3Bucket: "vitest-bucket", s3Key: "vitest/render-1.mp4", sizeBytes: 10 };
    await installRenderedClipMedia(args);
    await installRenderedClipMedia(args);
    expect(await mediaOf(item.id)).toHaveLength(1);
  });
});

describe("saveClipEdit", () => {
  it("bumps the revision and rejects a stale writer instead of overwriting", async () => {
    const { idea } = await seedIdea();
    await createTestClipEdit({ clipIdeaId: idea.id });
    const doc = createDefaultDoc({ startSec: 100, endSec: 130, hook: "tab one" });

    expect(await saveClipEdit({ clipIdeaId: idea.id, expectedRevision: 1, doc })).toEqual({ ok: true, revision: 2 });
    // A second tab still holding revision 1:
    expect(
      await saveClipEdit({ clipIdeaId: idea.id, expectedRevision: 1, doc: { ...doc, wordEdits: { "1": "x" } } }),
    ).toEqual({ ok: false, reason: "conflict", currentRevision: 2 });
  });

  it("mirrors the hook onto an undecided idea only", async () => {
    const open = await seedIdea();
    await createTestClipEdit({ clipIdeaId: open.idea.id });
    await saveClipEdit({
      clipIdeaId: open.idea.id, expectedRevision: 1,
      doc: createDefaultDoc({ startSec: 100, endSec: 130, hook: "new hook" }),
    });
    const [a] = await db.select({ hook: clipIdeas.hook }).from(clipIdeas).where(eq(clipIdeas.id, open.idea.id));
    expect(a.hook).toBe("new hook");

    const decided = await seedIdea({ status: "assigned" });
    await createTestClipEdit({ clipIdeaId: decided.idea.id });
    await saveClipEdit({
      clipIdeaId: decided.idea.id, expectedRevision: 1,
      doc: createDefaultDoc({ startSec: 100, endSec: 130, hook: "should not leak" }),
    });
    const [b] = await db.select({ hook: clipIdeas.hook }).from(clipIdeas).where(eq(clipIdeas.id, decided.idea.id));
    expect(b.hook).toBe("original hook");
  });
});

describe("toRenderStatus", () => {
  const base = {
    id: "r", clipEditId: "e", productionItemId: "p", doc: createDefaultDoc({ startSec: 0, endSec: 1, hook: "h" }),
    progress: 40, error: null, outputS3Bucket: null, outputS3Key: null, outputSizeBytes: null, durationSec: null,
    renderSeconds: null, requestedByUserId: null, finishedAt: null,
  };
  const now = Date.parse("2026-09-17T12:00:00Z");

  it("reports a render with a fresh heartbeat as rendering", () => {
    const row = { ...base, status: "rendering", createdAt: new Date(now - 60_000), startedAt: new Date(now - 50_000), heartbeatAt: new Date(now - 4_000) };
    expect(toRenderStatus(row, now).state).toBe("rendering");
  });

  it("derives `stalled` when the worker died without stamping a failure", () => {
    const row = { ...base, status: "rendering", createdAt: new Date(now - 3_600_000), startedAt: new Date(now - 3_500_000), heartbeatAt: new Date(now - RENDER_STALL_MS - 1) };
    expect(toRenderStatus(row, now).state).toBe("stalled");
  });
});
