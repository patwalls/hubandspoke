import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./whisper-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./whisper-pipeline")>()),
  extractAudioToS3: vi.fn(async () => ({
    audioS3Bucket: "b",
    audioS3Key: "k",
    chunks: [{ key: "k", startSec: 0 }],
  })),
  transcribeFromS3Audio: vi.fn(async () => {}),
}));

import type { JobHelpers } from "graphile-worker";
import { createTestProductionItem, createTestTranscript } from "@/test/factories";
import { extractAudioToS3 } from "./whisper-pipeline";
import { transcribeWhisperTask } from "./transcribe-whisper";

function makeHelpers() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    addJob: vi.fn(async () => ({})),
  } as unknown as JobHelpers & { addJob: ReturnType<typeof vi.fn> };
}

async function reelWithCaptionTranscript() {
  const reel = await createTestProductionItem({ mediaS3Key: "vitest/reel.mp4" });
  await createTestTranscript({
    productionItemId: reel.id,
    source: "scrape_creators_instagram",
    segments: [{ startSec: 0, endSec: 5, text: "caption text only" }],
  });
  return reel;
}

describe("transcribe-whisper over a caption-scrape transcript (HUBANDSPOKE-3E)", () => {
  beforeEach(() => vi.mocked(extractAudioToS3).mockClear());

  it("skips by default — a caption is a transcript", async () => {
    const reel = await reelWithCaptionTranscript();
    await transcribeWhisperTask({ productionItemId: reel.id }, makeHelpers());
    expect(extractAudioToS3).not.toHaveBeenCalled();
  });

  it("with needWords, transcribes and carries needWords into phase 2", async () => {
    const reel = await reelWithCaptionTranscript();
    const helpers = makeHelpers();
    await transcribeWhisperTask({ productionItemId: reel.id, needWords: true }, helpers);
    expect(extractAudioToS3).toHaveBeenCalledTimes(1);
    expect(helpers.addJob).toHaveBeenCalledWith(
      "transcribe-whisper",
      expect.objectContaining({ productionItemId: reel.id, needWords: true }),
      expect.anything(),
    );
  });

  it("with needWords, still skips a transcript that already has words", async () => {
    const reel = await createTestProductionItem({ mediaS3Key: "vitest/reel.mp4" });
    await createTestTranscript({
      productionItemId: reel.id,
      segments: [{ startSec: 0, endSec: 1, text: "hi" }],
      words: [{ word: "hi", startSec: 0, endSec: 1 }],
    });
    await transcribeWhisperTask({ productionItemId: reel.id, needWords: true }, makeHelpers());
    expect(extractAudioToS3).not.toHaveBeenCalled();
  });
});
