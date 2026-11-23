import { describe, expect, it } from "vitest";
import { brandSwitchHref } from "./brand-switch-href";

describe("brandSwitchHref", () => {
  it("flag off: dashboard, except Formats stays on Formats (old behaviour)", () => {
    expect(brandSwitchHref("/starter-story/production", "matg", false)).toBe("/matg");
    expect(brandSwitchHref("/starter-story/formats", "matg", false)).toBe("/matg/formats");
    expect(brandSwitchHref("/starter-story/formats", "all", false)).toBe("/all");
  });

  it("flag on: a list page carries over to the new brand", () => {
    expect(brandSwitchHref("/starter-story/production", "matg", true)).toBe("/matg/production");
    expect(brandSwitchHref("/matg/content", "starter-story", true)).toBe("/starter-story/content");
    expect(brandSwitchHref("/matg/accounts", "futurepedia", true)).toBe("/futurepedia/accounts");
  });

  it("flag on: a queue tab lands on the other brand's queue, not a format it may lack", () => {
    expect(brandSwitchHref("/starter-story/queue/cross-post", "matg", true)).toBe("/matg/queue");
  });

  it("flag on: post pages, format pages and the dashboard land on the dashboard", () => {
    expect(brandSwitchHref("/starter-story/content/abc-123", "matg", true)).toBe("/matg");
    expect(brandSwitchHref("/starter-story/formats/abc-123", "matg", true)).toBe("/matg");
    expect(brandSwitchHref("/starter-story", "matg", true)).toBe("/matg");
    expect(brandSwitchHref("/my-work", "matg", true)).toBe("/matg");
  });

  it("flag on: All keeps only the sections it has", () => {
    expect(brandSwitchHref("/matg/production", "all", true)).toBe("/all/production");
    expect(brandSwitchHref("/matg/accounts", "all", true)).toBe("/all");
    expect(brandSwitchHref("/all/production", "matg", true)).toBe("/matg/production");
  });
});
