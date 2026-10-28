import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentComments, productionItems } from "@/lib/db/schema";
import {
  createTestClipEdit,
  createTestClipIdea,
  createTestClipRender,
  createTestComment,
  createTestProductionItem,
  getTestUserId,
} from "@/test/factories";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import { closeNotesSettledByRender, loadEditorReviewNotes } from "./review-notes";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** A clip post with an editor render that is its video. */
async function seedClip() {
  const pillar = await createTestProductionItem({ postType: "youtube_long" });
  const post = await createTestProductionItem({ mediaS3Key: "vitest/render-a.mp4" });
  const idea = await createTestClipIdea({ sourceProductionItemId: pillar.id });
  const edit = await createTestClipEdit({ clipIdeaId: idea.id });
  return { post, edit };
}

describe("closeNotesSettledByRender (review-notes M4)", () => {
  it("marks done the open notes left before the re-render was requested", async () => {
    const { post, edit } = await seedClip();
    const userId = await getTestUserId();
    const before = await createTestComment({ contentItemId: post.id, atSeconds: 4, createdAt: minutesAgo(30) });
    const plain = await createTestComment({ contentItemId: post.id, createdAt: minutesAgo(30) });
    const render = await createTestClipRender({
      clipEditId: edit.id,
      productionItemId: post.id,
      status: "rendering",
      requestedByUserId: userId,
      createdAt: minutesAgo(10),
    });
    const during = await createTestComment({ contentItemId: post.id, atSeconds: 8, createdAt: minutesAgo(5) });

    expect(await closeNotesSettledByRender(render.id)).toBe(1);

    const rows = await db.select().from(contentComments).where(eq(contentComments.contentItemId, post.id));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[before.id].resolvedAt).not.toBeNull();
    expect(byId[before.id].resolvedByUserId).toBe(userId);
    expect(byId[before.id].resolvedByRenderId).toBe(render.id);
    // A plain comment is conversation, not a to-do; a note written while it
    // rendered was never in front of whoever exported.
    expect(byId[plain.id].resolvedAt).toBeNull();
    expect(byId[during.id].resolvedAt).toBeNull();

    // A retried task closes nothing more.
    expect(await closeNotesSettledByRender(render.id)).toBe(0);
  });

  it("leaves a note someone already marked done as theirs", async () => {
    const { post, edit } = await seedClip();
    const note = await createTestComment({ contentItemId: post.id, atSeconds: 2, createdAt: minutesAgo(30) });
    const doneAt = minutesAgo(20);
    await db.update(contentComments).set({ resolvedAt: doneAt }).where(eq(contentComments.id, note.id));
    const render = await createTestClipRender({ clipEditId: edit.id, productionItemId: post.id });

    expect(await closeNotesSettledByRender(render.id)).toBe(0);
    const [row] = await db.select().from(contentComments).where(eq(contentComments.id, note.id));
    expect(row.resolvedByRenderId).toBeNull();
  });
});

describe("loadEditorReviewNotes (review-notes M3)", () => {
  it("returns open notes by moment, with the doc of the render they were left on", async () => {
    const { post, edit } = await seedClip();
    const renderedDoc = createDefaultDoc({ startSec: 10, endSec: 25, hook: "rendered" });
    await createTestClipRender({
      clipEditId: edit.id,
      productionItemId: post.id,
      doc: renderedDoc,
      outputS3Key: "vitest/render-a.mp4",
    });
    await createTestComment({ contentItemId: post.id, atSeconds: 9, body: "later" });
    await createTestComment({ contentItemId: post.id, atSeconds: 3, body: "sooner" });
    await createTestComment({ contentItemId: post.id, body: "just chat" });
    const done = await createTestComment({ contentItemId: post.id, atSeconds: 5, body: "handled" });
    await db.update(contentComments).set({ resolvedAt: new Date() }).where(eq(contentComments.id, done.id));

    const out = await loadEditorReviewNotes(post.id);
    expect(out.notes.map((n) => n.body)).toEqual(["sooner", "later"]);
    expect(out.renderedDoc?.sections[0].startSec).toBe(10);
  });

  it("has no rendered doc once the post's video is something else", async () => {
    const { post, edit } = await seedClip();
    await createTestClipRender({ clipEditId: edit.id, productionItemId: post.id, outputS3Key: "vitest/render-a.mp4" });
    await db.update(productionItems).set({ mediaS3Key: "vitest/uploaded.mp4" }).where(eq(productionItems.id, post.id));
    await createTestComment({ contentItemId: post.id, atSeconds: 3 });

    const out = await loadEditorReviewNotes(post.id);
    expect(out.notes).toHaveLength(1);
    expect(out.renderedDoc).toBeNull();
  });
});
