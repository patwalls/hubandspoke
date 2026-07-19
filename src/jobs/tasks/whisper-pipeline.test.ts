import { describe, it, expect } from "vitest";
import {
  WhisperTranscribeError,
  isPermanentWhisperError,
} from "./whisper-pipeline";

describe("isPermanentWhisperError", () => {
  it("classifies unprocessable-media kinds as permanent", () => {
    for (const kind of [
      "no_media",
      "not_av",
      "ffmpeg_failed",
      "audio_too_large",
    ] as const) {
      expect(
        isPermanentWhisperError(new WhisperTranscribeError("x", kind)),
      ).toBe(true);
    }
  });

  it("keeps resource/transient kinds retryable", () => {
    // ffmpeg_timeout is a slow-dyno/big-file condition, not bad input; the
    // Whisper API can blip; unknown stays conservative and retries.
    for (const kind of ["ffmpeg_timeout", "whisper_failed", "unknown"] as const) {
      expect(
        isPermanentWhisperError(new WhisperTranscribeError("x", kind)),
      ).toBe(false);
    }
  });

  it("ignores non-WhisperTranscribeError values", () => {
    expect(isPermanentWhisperError(new Error("ffmpeg_failed"))).toBe(false);
    expect(isPermanentWhisperError("ffmpeg_failed")).toBe(false);
    expect(isPermanentWhisperError(null)).toBe(false);
  });
});
