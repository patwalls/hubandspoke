/**
 * The editor session carries the section picker's stitch-in suggestions
 * (clip stitching M2): the clip's own section's lines, and none once that
 * section is killed.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createTestClipIdea,
  createTestClipSection,
  createTestProductionItem,
  createTestTranscript,
  getTestUserId,
} from "@/test/factories";
import type { SupportingMoment } from "@/lib/clip-stitch";

vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/s3", async (orig) => ({
  ...(await orig<typeof import("@/lib/s3")>()),
  getPresignedGetUrl: async () => "https://vitest.invalid/pillar.mp4",
}));

const { loadClipEditorSession } = await import("./session");

const MOMENT: SupportingMoment = {
  quote: "we were doing ten grand a month by then",
  role: "payoff",
  why: "The number the clip's tactic pays off in",
  startSec: 400,
  endSec: 406,
};

async function seed(opts: { killed?: boolean; moments?: SupportingMoment[] | null }) {
  const pillar = await createTestProductionItem({
    postType: "youtube_long",
    mediaS3Bucket: "vitest-bucket",
    mediaS3Key: "vitest/pillar.mp4",
  });
  await createTestTranscript({
    productionItemId: pillar.id,
    segments: [
      { startSec: 0, endSec: 200, text: "the opening of the episode" },
      { startSec: 400, endSec: 406, text: MOMENT.quote },
    ],
  });
  const section = await createTestClipSection({
    pillarId: pillar.id,
    supportingMoments: opts.moments === undefined ? [MOMENT] : opts.moments,
    killedAt: opts.killed ? new Date() : undefined,
  });
  return createTestClipIdea({ sourceProductionItemId: pillar.id, clipSectionId: section.id, startSec: 10, endSec: 40 });
}

describe("loadClipEditorSession · supportingMoments", () => {
  it("offers the section's stitch-in lines", async () => {
    const idea = await seed({});
    const session = await loadClipEditorSession({ clipIdeaId: idea.id, userId: await getTestUserId() });
    expect(session.supportingMoments).toEqual([MOMENT]);
  });

  it("offers none for a killed section or a pre-v2 section", async () => {
    const userId = await getTestUserId();
    const killed = await seed({ killed: true });
    expect((await loadClipEditorSession({ clipIdeaId: killed.id, userId })).supportingMoments).toEqual([]);
    const old = await seed({ moments: null });
    expect((await loadClipEditorSession({ clipIdeaId: old.id, userId })).supportingMoments).toEqual([]);
  });
});
