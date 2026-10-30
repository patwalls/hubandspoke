import { describe, it, expect, vi, beforeEach } from "vitest";

// Never reach Descript or the real queue.
vi.mock("@/lib/descript", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/descript")>()),
  cutSegmentWithRules: vi.fn(async () => ({
    jobId: "job-1",
    projectUrl: "https://web.descript.com/p",
    projectId: "proj",
    prompt: "",
  })),
}));
vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn(async () => {}) }));

import type { JobHelpers } from "graphile-worker";
import { createTestProductionItem, createTestTranscript } from "@/test/factories";
import { enqueue } from "@/jobs/enqueue";
import { cutSegmentWithRules } from "@/lib/descript";
import { descriptDerivativeCreateTask } from "./descript-derivative-create";

const LINE = "claude can now make a whole video from one prompt and it is wild";

function makeHelpers() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    addJob: vi.fn(async () => ({})),
  } as unknown as JobHelpers & { addJob: ReturnType<typeof vi.fn> };
}

function timed(text: string, offset = 0) {
  return text.split(" ").map((word, i) => ({
    word,
    startSec: offset + i * 0.5,
    endSec: offset + i * 0.5 + 0.4,
  }));
}

/** The HUBANDSPOKE-3E shape: a Reel clipped from a pillar, cross-posted.
 *  The pillar is in Descript with Whisper words; the Reel only has the
 *  Instagram caption scrape (text, no words) but its video is archived. */
async function crossPostOfCaptionOnlyReel(opts: { reelMedia: boolean }) {
  const pillar = await createTestProductionItem({
    descriptProjectId: "proj",
    descriptSeedCompositionId: "seed",
    mediaS3Key: "vitest/pillar.mp4",
  });
  await createTestTranscript({
    productionItemId: pillar.id,
    segments: [{ startSec: 0, endSec: 40, text: `intro words here ${LINE} outro` }],
    words: timed(`intro words here ${LINE} outro`),
  });
  const reel = await createTestProductionItem({
    sourceType: "repurposed",
    pillarContentItemId: pillar.id,
    mediaS3Key: opts.reelMedia ? "vitest/reel.mp4" : null,
  });
  await createTestTranscript({
    productionItemId: reel.id,
    source: "scrape_creators_instagram",
    segments: [{ startSec: 0, endSec: 8, text: LINE }],
  });
  const crossPost = await createTestProductionItem({
    sourceType: "cross_post",
    repostedFromItemId: reel.id,
  });
  return { pillar, reel, crossPost };
}

describe("descript-derivative-create when the source has no word timings (HUBANDSPOKE-3E)", () => {
  beforeEach(() => {
    vi.mocked(enqueue).mockClear();
    vi.mocked(cutSegmentWithRules).mockClear();
  });

  it("asks Whisper for words and re-polls instead of blocking", async () => {
    const { reel, crossPost } = await crossPostOfCaptionOnlyReel({ reelMedia: true });
    const helpers = makeHelpers();
    const payload = { derivativeItemId: crossPost.id, sourceItemId: reel.id };

    await expect(descriptDerivativeCreateTask(payload, helpers)).resolves.toBeUndefined();

    expect(enqueue).toHaveBeenCalledWith(
      "transcribe-whisper",
      { productionItemId: reel.id, needWords: true },
      { jobKey: `transcribe-whisper:${reel.id}` },
    );
    expect(helpers.addJob).toHaveBeenCalledWith(
      "descript-derivative-create",
      { ...payload, attempt: 1, wordsRequested: true },
      expect.anything(),
    );
    expect(cutSegmentWithRules).not.toHaveBeenCalled();
  });

  it("waits without re-asking Whisper on the next pass", async () => {
    const { reel, crossPost } = await crossPostOfCaptionOnlyReel({ reelMedia: true });
    const helpers = makeHelpers();
    await descriptDerivativeCreateTask(
      { derivativeItemId: crossPost.id, sourceItemId: reel.id, attempt: 1, wordsRequested: true },
      helpers,
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(helpers.addJob).toHaveBeenCalledTimes(1);
  });

  it("cuts once Whisper's words have landed", async () => {
    const { reel, crossPost } = await crossPostOfCaptionOnlyReel({ reelMedia: true });
    const { db } = await import("@/lib/db");
    const { transcripts } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(transcripts).set({ words: timed(LINE) }).where(eq(transcripts.productionItemId, reel.id));

    await descriptDerivativeCreateTask(
      { derivativeItemId: crossPost.id, sourceItemId: reel.id, attempt: 1, wordsRequested: true },
      makeHelpers(),
    );
    expect(cutSegmentWithRules).toHaveBeenCalledTimes(1);
  });

  it("blocks (for the UI, not Sentry) when there is no media to transcribe", async () => {
    const { reel, crossPost } = await crossPostOfCaptionOnlyReel({ reelMedia: false });
    await expect(
      descriptDerivativeCreateTask(
        { derivativeItemId: crossPost.id, sourceItemId: reel.id },
        makeHelpers(),
      ),
    ).rejects.toThrow(/^blocked:needs_transcript: source .* no archived media to transcribe/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("blocks once the wait budget is spent", async () => {
    const { reel, crossPost } = await crossPostOfCaptionOnlyReel({ reelMedia: true });
    await expect(
      descriptDerivativeCreateTask(
        { derivativeItemId: crossPost.id, sourceItemId: reel.id, attempt: 9, wordsRequested: true },
        makeHelpers(),
      ),
    ).rejects.toThrow(/^blocked:needs_transcript: .*Whisper didn't produce them/);
  });
});
