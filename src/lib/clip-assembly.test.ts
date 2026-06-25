import { describe, it, expect } from "vitest";
import {
  buildConcatFfmpegArgs,
  buildConcatFilterComplex,
  isValidSegment,
} from "./clip-assembly";

describe("isValidSegment", () => {
  it("accepts a positive-length, non-negative range", () => {
    expect(isValidSegment({ startSec: 0, endSec: 5 })).toBe(true);
    expect(isValidSegment({ startSec: 12.5, endSec: 30 })).toBe(true);
  });

  it("rejects zero-length, inverted, negative, or non-finite ranges", () => {
    expect(isValidSegment({ startSec: 5, endSec: 5 })).toBe(false);
    expect(isValidSegment({ startSec: 10, endSec: 4 })).toBe(false);
    expect(isValidSegment({ startSec: -1, endSec: 4 })).toBe(false);
    expect(isValidSegment({ startSec: 0, endSec: Infinity })).toBe(false);
    expect(isValidSegment({ startSec: NaN, endSec: 4 })).toBe(false);
  });
});

describe("buildConcatFilterComplex", () => {
  it("emits a per-input setpts+concat graph for two segments (hook → body)", () => {
    const filter = buildConcatFilterComplex([
      { startSec: 2, endSec: 6 }, // intro hook
      { startSec: 381.2, endSec: 450.5 }, // body
    ]);
    // Each segment is its own input (input-seeked in the argv), so the filter
    // references [0:..]/[1:..] and only normalizes PTS — no in-filter trim.
    expect(filter).toBe(
      "[0:v]setpts=PTS-STARTPTS[v0];" +
        "[0:a]asetpts=PTS-STARTPTS[a0];" +
        "[1:v]setpts=PTS-STARTPTS[v1];" +
        "[1:a]asetpts=PTS-STARTPTS[a1];" +
        "[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]",
    );
  });

  it("scales the concat input list and n= to the segment count", () => {
    const filter = buildConcatFilterComplex([
      { startSec: 0, endSec: 1 },
      { startSec: 2, endSec: 3 },
      { startSec: 4, endSec: 5 },
    ]);
    expect(filter).toContain("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1");
  });

  it("throws when given fewer than two segments", () => {
    expect(() => buildConcatFilterComplex([{ startSec: 0, endSec: 5 }])).toThrow(
      /≥2 segments/,
    );
  });
});

describe("buildConcatFfmpegArgs", () => {
  it("input-seeks each segment (fast) instead of decoding from zero", () => {
    const args = buildConcatFfmpegArgs({
      inputPath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      segments: [
        { startSec: 2, endSec: 6 },
        { startSec: 100, endSec: 130 },
      ],
    });
    // One input-seeked open per segment: -ss <start> -t <dur> -i <src>
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args.filter((a) => a === "/tmp/src.mp4")).toHaveLength(2);
    // First segment: -ss 2 -t 4, second: -ss 100 -t 30 (durations, not -to)
    const i0 = args.indexOf("-ss");
    expect(args.slice(i0, i0 + 4)).toEqual(["-ss", "2", "-t", "4"]);
    const i1 = args.indexOf("-ss", i0 + 4);
    expect(args.slice(i1, i1 + 4)).toEqual(["-ss", "100", "-t", "30"]);
    // both streams mapped out of the concat
    expect(args).toContain("[outv]");
    expect(args).toContain("[outa]");
    // codecs mirror the single-cut path so Descript's importer accepts it
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    // output is last
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });
});
