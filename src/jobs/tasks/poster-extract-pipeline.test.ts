import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import {
  PosterExtractError,
  isAudioOnlyContentType,
  runFfmpegExtractFrame,
} from "./poster-extract-pipeline";

const logger = { info: () => {} };

function ffmpeg(args: string[]) {
  const r = spawnSync(ffmpegInstaller.path, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.status !== 0) throw new Error(`fixture ffmpeg failed: ${r.stderr}`);
}

describe("runFfmpegExtractFrame", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "poster-extract-test-"));
    // HUBANDSPOKE-3C: a TikTok archived as audio/mp4 — the soundtrack only.
    ffmpeg(["-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", join(dir, "audio.mp4")]);
    ffmpeg([
      "-f", "lavfi", "-i", "color=c=red:s=32x32:d=1",
      "-pix_fmt", "yuv420p", join(dir, "video.mp4"),
    ]);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("classifies audio-only input as no_video_stream, not ffmpeg_failed", async () => {
    const err = await runFfmpegExtractFrame({
      inputPath: join(dir, "audio.mp4"),
      outputPath: join(dir, "audio-frame.jpg"),
      logger,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PosterExtractError);
    expect((err as PosterExtractError).kind).toBe("no_video_stream");
  });

  it("still grabs frame 0 from a real video", async () => {
    const out = join(dir, "video-frame.jpg");
    await runFfmpegExtractFrame({ inputPath: join(dir, "video.mp4"), outputPath: out, logger });
    expect((await stat(out)).size).toBeGreaterThan(0);
  });

  it("keeps other ffmpeg failures as ffmpeg_failed", async () => {
    const err = await runFfmpegExtractFrame({
      inputPath: join(dir, "missing.mp4"),
      outputPath: join(dir, "missing-frame.jpg"),
      logger,
    }).catch((e) => e);
    expect((err as PosterExtractError).kind).toBe("ffmpeg_failed");
  });
});

describe("isAudioOnlyContentType", () => {
  it("flags audio/* only", () => {
    expect(isAudioOnlyContentType("audio/mp4")).toBe(true);
    expect(isAudioOnlyContentType("Audio/MPEG")).toBe(true);
    expect(isAudioOnlyContentType("video/mp4")).toBe(false);
    expect(isAudioOnlyContentType(null)).toBe(false);
  });
});
