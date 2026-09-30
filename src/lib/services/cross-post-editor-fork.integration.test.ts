import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clipEdits,
  clipIdeas,
  clipRenders,
  designDocs,
  designRenders,
  productionItems,
} from "@/lib/db/schema";
import {
  createTestClipEdit,
  createTestClipIdea,
  createTestClipRender,
  createTestDesignDoc,
  createTestDesignRender,
  createTestProductionItem,
  getTestUserId,
  minimalDesignDoc,
} from "@/test/factories";
import { forkEditorStateForCrossPost } from "./cross-post-editor-fork";

/** Run the fork in a real transaction, the way the cross-post route does. */
async function fork(sourceId: string, crossPostId: string, userId: string) {
  await db.transaction((tx) =>
    forkEditorStateForCrossPost(tx, { sourceId, crossPostId, userId }),
  );
}

describe("forkEditorStateForCrossPost — design editor", () => {
  it("copies the source's design doc + render onto the cross-post as its own rows", async () => {
    const userId = await getTestUserId();
    const source = await createTestProductionItem({ postType: "instagram_post" });
    const srcDoc = await createTestDesignDoc({
      productionItemId: source.id,
      doc: { ...minimalDesignDoc(), template: "playbook" },
      brief: { caption: "hello from source" },
    });
    await createTestDesignRender({
      designDocId: srcDoc.id,
      productionItemId: source.id,
      outputKeys: ["slides/a.png", "slides/b.png"],
    });
    const crossPost = await createTestProductionItem({
      postType: "linkedin",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
    });

    await fork(source.id, crossPost.id, userId);

    const [forkedDoc] = await db
      .select()
      .from(designDocs)
      .where(eq(designDocs.productionItemId, crossPost.id));
    expect(forkedDoc).toBeTruthy();
    expect(forkedDoc.id).not.toBe(srcDoc.id); // a separate row, not the source's
    expect(forkedDoc.doc).toEqual(srcDoc.doc);
    expect(forkedDoc.brief).toEqual({ caption: "hello from source" });

    const [forkedRender] = await db
      .select()
      .from(designRenders)
      .where(eq(designRenders.productionItemId, crossPost.id));
    expect(forkedRender).toBeTruthy();
    expect(forkedRender.status).toBe("done");
    expect(forkedRender.designDocId).toBe(forkedDoc.id);
    expect(forkedRender.outputKeys).toEqual(["slides/a.png", "slides/b.png"]);
  });

  it("never mutates the source design when the cross-post is edited", async () => {
    const userId = await getTestUserId();
    const source = await createTestProductionItem({ postType: "instagram_post" });
    const srcDoc = await createTestDesignDoc({ productionItemId: source.id });
    await createTestDesignRender({ designDocId: srcDoc.id, productionItemId: source.id });
    const crossPost = await createTestProductionItem({
      postType: "linkedin",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
    });

    await fork(source.id, crossPost.id, userId);

    // Edit the cross-post's design, as the editor would.
    const edited = { ...minimalDesignDoc(), template: "edited-on-crosspost" };
    await db
      .update(designDocs)
      .set({ doc: edited })
      .where(eq(designDocs.productionItemId, crossPost.id));

    const [sourceAfter] = await db
      .select()
      .from(designDocs)
      .where(eq(designDocs.productionItemId, source.id));
    expect(sourceAfter.doc).toEqual(srcDoc.doc);
    expect((sourceAfter.doc as { template: string }).template).not.toBe(
      "edited-on-crosspost",
    );
  });

  it("does not fork a design that never rendered", async () => {
    const userId = await getTestUserId();
    const source = await createTestProductionItem({ postType: "instagram_post" });
    await createTestDesignDoc({ productionItemId: source.id }); // doc, no render
    const crossPost = await createTestProductionItem({
      postType: "linkedin",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
    });

    await fork(source.id, crossPost.id, userId);

    const rows = await db
      .select()
      .from(designDocs)
      .where(eq(designDocs.productionItemId, crossPost.id));
    expect(rows).toHaveLength(0);
  });
});

describe("forkEditorStateForCrossPost — clip editor", () => {
  it("forks a clip idea + edit + render for the cross-post, leaving the source untouched", async () => {
    const userId = await getTestUserId();
    const pillar = await createTestProductionItem({ postType: "youtube_long" });
    const source = await createTestProductionItem({
      postType: "instagram_reel",
      pillarContentItemId: pillar.id,
    });
    const idea = await createTestClipIdea({
      sourceProductionItemId: pillar.id,
      hook: "the source hook",
      startSec: 5,
      endSec: 35,
    });
    const edit = await createTestClipEdit({ clipIdeaId: idea.id });
    await createTestClipRender({
      clipEditId: edit.id,
      productionItemId: source.id,
      outputS3Key: "clips/source.mp4",
    });
    const crossPost = await createTestProductionItem({
      postType: "tiktok",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
    });

    await fork(source.id, crossPost.id, userId);

    // A new clip idea, accepted to the cross-post, kept out of triage.
    const forkedIdeas = await db
      .select()
      .from(clipIdeas)
      .where(eq(clipIdeas.acceptedProductionItemId, crossPost.id));
    expect(forkedIdeas).toHaveLength(1);
    const forkedIdea = forkedIdeas[0];
    expect(forkedIdea.id).not.toBe(idea.id);
    expect(forkedIdea.status).toBe("assigned");
    expect(forkedIdea.hook).toBe("the source hook");
    expect(forkedIdea.sourceProductionItemId).toBe(pillar.id);

    // Its own edit + render.
    const [forkedEdit] = await db
      .select()
      .from(clipEdits)
      .where(eq(clipEdits.clipIdeaId, forkedIdea.id));
    expect(forkedEdit).toBeTruthy();
    expect(forkedEdit.id).not.toBe(edit.id);
    expect(forkedEdit.doc).toEqual(edit.doc);

    const [forkedRender] = await db
      .select()
      .from(clipRenders)
      .where(eq(clipRenders.productionItemId, crossPost.id));
    expect(forkedRender).toBeTruthy();
    expect(forkedRender.status).toBe("done");
    expect(forkedRender.outputS3Key).toBe("clips/source.mp4");

    // Cross-post points at its own forked idea for lineage.
    const [crossPostAfter] = await db
      .select({ sourceClipIdeaId: productionItems.sourceClipIdeaId })
      .from(productionItems)
      .where(eq(productionItems.id, crossPost.id));
    expect(crossPostAfter.sourceClipIdeaId).toBe(forkedIdea.id);

    // The source idea is unchanged.
    const [sourceIdeaAfter] = await db
      .select()
      .from(clipIdeas)
      .where(eq(clipIdeas.id, idea.id));
    expect(sourceIdeaAfter.status).toBe("suggested");
    expect(sourceIdeaAfter.acceptedProductionItemId).toBeNull();
  });

  it("does not fork a clip that never rendered", async () => {
    const userId = await getTestUserId();
    const pillar = await createTestProductionItem({ postType: "youtube_long" });
    const source = await createTestProductionItem({
      postType: "instagram_reel",
      pillarContentItemId: pillar.id,
    });
    const idea = await createTestClipIdea({ sourceProductionItemId: pillar.id });
    await createTestClipEdit({ clipIdeaId: idea.id }); // edit, no render
    const crossPost = await createTestProductionItem({
      postType: "tiktok",
      sourceType: "cross_post",
      repostedFromItemId: source.id,
    });

    await fork(source.id, crossPost.id, userId);

    const forkedIdeas = await db
      .select()
      .from(clipIdeas)
      .where(eq(clipIdeas.acceptedProductionItemId, crossPost.id));
    expect(forkedIdeas).toHaveLength(0);
    const forkedRenders = await db
      .select()
      .from(clipRenders)
      .where(eq(clipRenders.productionItemId, crossPost.id));
    expect(forkedRenders).toHaveLength(0);
  });
});
