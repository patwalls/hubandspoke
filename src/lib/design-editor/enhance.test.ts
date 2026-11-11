import { describe, expect, it } from "vitest";
import { canEnhance, enhanceOutputSize, enhancePrompt, enhanceSourceKey } from "./enhance";

describe("enhanceOutputSize", () => {
  it("keeps a 16:9 video frame 16:9 at a 2048 long side", () => {
    expect(enhanceOutputSize(640, 360)).toEqual({ width: 2048, height: 1152 });
    expect(enhanceOutputSize(1920, 1080)).toEqual({ width: 2048, height: 1152 });
  });

  it("keeps a 4:5 portrait upright", () => {
    const s = enhanceOutputSize(1080, 1350);
    expect(s.height).toBe(2048);
    expect(s.width % 16).toBe(0);
    expect(Math.abs(s.width / s.height - 0.8)).toBeLessThan(0.01);
  });

  it("clamps a panorama to 3:1 (the model's limit)", () => {
    expect(enhanceOutputSize(4000, 500)).toEqual({ width: 2048, height: 688 });
  });

  it("falls back to a square when the size is unknown", () => {
    expect(enhanceOutputSize(0, 0)).toEqual({ width: 2048, height: 2048 });
  });
});

describe("enhance keys + prompt", () => {
  const src = { kind: "s3" as const, bucket: "b", key: "k.jpg" };

  it("keys the plain and blurred enhancements of one picture apart", () => {
    expect(enhanceSourceKey(src, false)).not.toBe(enhanceSourceKey(src, true));
  });

  it("only asks for the blur when asked", () => {
    expect(enhancePrompt(false)).not.toMatch(/bokeh/);
    expect(enhancePrompt(true)).toMatch(/bokeh/);
  });

  it("enhances stored and https pictures, not bundled logos or http", () => {
    expect(canEnhance(src)).toBe(true);
    expect(canEnhance({ kind: "url", url: "https://x.com/a.jpg" })).toBe(true);
    expect(canEnhance({ kind: "url", url: "http://x.com/a.jpg" })).toBe(false);
    expect(canEnhance({ kind: "asset", path: "/watermarks/a.png" })).toBe(false);
  });
});
