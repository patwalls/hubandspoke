import { describe, it, expect } from "vitest";
import { screenFor, isValidMark } from "./screen";

describe("screenFor", () => {
  it("collapses the brand slug and keeps it separately", () => {
    expect(screenFor("/starter-story/queue/clips")).toEqual({
      screen: "/[brand]/queue/clips",
      brand: "starter-story",
    });
  });

  it("treats `all` as a brand, not a top-level route", () => {
    expect(screenFor("/all/content")).toEqual({ screen: "/[brand]/content", brand: "all" });
  });

  it("keeps top-level routes as they are", () => {
    expect(screenFor("/my-work")).toEqual({ screen: "/my-work", brand: null });
    expect(screenFor("/settings/users")).toEqual({ screen: "/settings/users", brand: null });
    expect(screenFor("/")).toEqual({ screen: "/", brand: null });
  });

  it("never stores a content or format id", () => {
    expect(screenFor("/matg/content/1a2b3c4d-1111-2222-3333-444455556666").screen).toBe(
      "/[brand]/content/[id]",
    );
    expect(screenFor("/matg/formats/some-format-slug").screen).toBe("/[brand]/formats/[id]");
    expect(screenFor("/settings/brands/matg").screen).toBe("/settings/brands/[brand]");
  });

  it("keeps only allowlisted, word-shaped query params", () => {
    expect(screenFor("/matg/queue", "?tab=ready&q=secret+search").screen).toBe(
      "/[brand]/queue?tab=ready",
    );
    expect(screenFor("/matg/queue", "?tab=<script>").screen).toBe("/[brand]/queue");
  });
});

it("records an open triage modal without its id", () => {
  expect(screenFor("/matg/queue/clips", "?clip=abc-123&tab=ready").screen).toBe(
    "/[brand]/queue/clips?tab=ready&clip=[id]",
  );
});

describe("isValidMark", () => {
  it("accepts structural marks and rejects free text", () => {
    expect(isValidMark("modal:clip-editor")).toBe(true);
    expect(isValidMark("whats-new:click:2026-10-21-whats-new")).toBe(true);
    expect(isValidMark("hello world")).toBe(false);
    expect(isValidMark("x".repeat(200))).toBe(false);
  });
});
