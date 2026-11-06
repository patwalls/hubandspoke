import { describe, expect, it } from "vitest";
import { compactNumber, postTypeLabel } from "./cards";

describe("assistant card formatting", () => {
  it("rounds big numbers the way the dashboard reads", () => {
    expect(compactNumber(1_090_000)).toBe("1.09M");
    expect(compactNumber(44_700)).toBe("44.7K");
    expect(compactNumber(950)).toBe("950");
    expect(compactNumber(null)).toBe("—");
  });

  it("labels post types in plain words", () => {
    expect(postTypeLabel("instagram_reel")).toBe("Instagram Reel");
    expect(postTypeLabel("youtube_shorts")).toBe("YouTube Short");
    expect(postTypeLabel("some_new_type")).toBe("Some New Type");
    expect(postTypeLabel(null)).toBe("Post");
  });
});
