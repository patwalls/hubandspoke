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
  it("emits a trim+concat graph for two segments (hook → body)", () => {
    const filter = buildConcatFilterComplex([
      { startSec: 2, endSec: 6 }, // intro hook
      { startSec: 381.2, endSec: 450.5 }, // body
    ]);
    expect(filter).toBe(
      "[0:v]trim=start=2:end=6,setpts=PTS-STARTPTS[v0];" +
        "[0:a]atrim=start=2:end=6,asetpts=PTS-STARTPTS[a0];" +
        "[0:v]trim=start=381.2:end=450.5,setpts=PTS-STARTPTS[v1];" +
        "[0:a]atrim=start=381.2:end=450.5,asetpts=PTS-STARTPTS[a1];" +
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
  it("wraps the filter with one input, both maps, and Descript-safe codecs", () => {
    const args = buildConcatFfmpegArgs({
      inputPath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      segments: [
        { startSec: 2, endSec: 6 },
        { startSec: 100, endSec: 130 },
      ],
    });
    // single input, in order
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/src.mp4");
    // both streams mapped out of the concat
    expect(args).toContain("-map");
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
