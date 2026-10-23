import { describe, it, expect, vi } from "vitest";

// The task must never reach S3/ffmpeg for media it can't make a poster from.
vi.mock("./poster-extract-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./poster-extract-pipeline")>()),
  extractPosterFromMediaS3: vi.fn(),
}));

import type { JobHelpers } from "graphile-worker";
import { createTestProductionItem } from "@/test/factories";
import { extractPosterTask, selectExtractPosterCandidates } from "./extract-poster";
import { PosterExtractError, extractPosterFromMediaS3 } from "./poster-extract-pipeline";

const helpers = { logger: { info: vi.fn() } } as unknown as JobHelpers;

function shortFormItem(mediaContentType: string) {
  return createTestProductionItem({
    status: "Published",
    postType: "tiktok",
    mediaS3Key: `vitest/${mediaContentType}.bin`,
    mediaContentType,
    views: 2_000_000_000, // top of the views-DESC batch
  });
}

describe("extract-poster with audio-only media (HUBANDSPOKE-3C)", () => {
  it("the sweep never selects audio-only items", async () => {
    const audio = await shortFormItem("audio/mp4");
    const video = await shortFormItem("video/mp4");
    const ids = await selectExtractPosterCandidates();
    expect(ids).toContain(video.id);
    expect(ids).not.toContain(audio.id);
  });

  it("the task skips audio-only items without running ffmpeg", async () => {
    const audio = await shortFormItem("audio/mp4");
    vi.mocked(extractPosterFromMediaS3).mockClear();
    await extractPosterTask({ productionItemId: audio.id }, helpers);
    expect(extractPosterFromMediaS3).not.toHaveBeenCalled();
  });

  it("a no-video-stream ffmpeg result completes quietly instead of retrying", async () => {
    const mislabelled = await shortFormItem("video/mp4");
    vi.mocked(extractPosterFromMediaS3).mockRejectedValueOnce(
      new PosterExtractError("ffmpeg exited 1: Output file #0 does not contain any stream", "no_video_stream"),
    );
    await expect(
      extractPosterTask({ productionItemId: mislabelled.id }, helpers),
    ).resolves.toBeUndefined();
  });

  it("other poster failures still throw so graphile retries", async () => {
    const item = await shortFormItem("video/mp4");
    vi.mocked(extractPosterFromMediaS3).mockRejectedValueOnce(
      new PosterExtractError("download from S3 failed", "download_failed"),
    );
    await expect(extractPosterTask({ productionItemId: item.id }, helpers)).rejects.toThrow(
      "download from S3 failed",
    );
  });
});
