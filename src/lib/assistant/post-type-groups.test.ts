import { describe, expect, it } from "vitest";
import { resolvePostTypes } from "./post-type-groups";

describe("resolvePostTypes", () => {
  it("expands a group so short-form is one search, not one per platform", () => {
    expect(resolvePostTypes("short_form")).toEqual(["youtube_shorts", "instagram_reel", "tiktok"]);
    expect(resolvePostTypes("Short-form")).toEqual(["youtube_shorts", "instagram_reel", "tiktok"]);
  });

  it("accepts a single type or a comma list, mixing in groups without duplicates", () => {
    expect(resolvePostTypes("x")).toEqual(["x"]);
    expect(resolvePostTypes("tiktok, long_form, tiktok")).toEqual(["tiktok", "youtube_long"]);
  });

  it("means no filter when blank", () => {
    expect(resolvePostTypes("")).toBeUndefined();
    expect(resolvePostTypes(undefined)).toBeUndefined();
  });
});
