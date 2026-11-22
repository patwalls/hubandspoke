import { describe, expect, it } from "vitest";
import type { ProductionRun } from "@/lib/production/run";
import { nextAfterPublish, type NextPostBrief } from "./next-after-publish";

const post = (id: string, status = "Ready To Publish", postType: string | null = "instagram_reel"): NextPostBrief => ({
  id,
  title: `Post ${id}`,
  brand: "starter-story",
  status,
  postType,
});

const run = (group: string, ids: string[], extra: Partial<ProductionRun> = {}): ProductionRun => ({
  brand: "starter-story",
  group,
  rows: ids.map((id) => ({ id, title: `Row ${id}` })),
  at: Date.now(),
  ...extra,
});

const base = { itemId: "a", brand: "starter-story" };

describe("nextAfterPublish", () => {
  it("offers the same post's next Ready cross-post first, over the run", () => {
    const got = nextAfterPublish({
      ...base,
      myWork: { next: post("s1", "Ready To Publish", "threads"), sameSource: true, siblings: [post("s1", "Ready To Publish", "threads")] },
      run: run("Ready To Publish", ["a", "b"]),
    });
    expect(got).toEqual({ id: "s1", brand: "starter-story", title: "Post s1", postType: "threads", from: "same-post" });
  });

  it("skips a sibling that isn't Ready To Publish (still being edited)", () => {
    const got = nextAfterPublish({
      ...base,
      myWork: { next: post("s1", "Assigned"), sameSource: true, siblings: [post("s1", "Assigned"), post("s2")] },
      run: null,
    });
    expect(got?.id).toBe("s2");
    expect(got?.from).toBe("same-post");
  });

  it("falls back to the next row of a Ready To Publish run", () => {
    const got = nextAfterPublish({ ...base, myWork: null, run: run("Ready To Publish", ["x", "a", "b"]) });
    expect(got).toMatchObject({ id: "b", title: "Row b", from: "run" });
  });

  it("wraps to the first row when the post was the last in the run", () => {
    const got = nextAfterPublish({ ...base, myWork: null, run: run("Ready To Publish", ["x", "a"]) });
    expect(got?.id).toBe("x");
  });

  it("ignores a run of another status group, another brand, or the Content list", () => {
    for (const r of [
      run("Review", ["a", "b"]),
      run("Ready To Publish", ["a", "b"], { brand: "matg" }),
      run("Ready To Publish", ["a", "b"], { source: "content" }),
    ]) {
      expect(nextAfterPublish({ ...base, myWork: null, run: r })).toBeNull();
    }
  });

  it("is null when the post is the run's only row", () => {
    expect(nextAfterPublish({ ...base, myWork: null, run: run("Ready To Publish", ["a"]) })).toBeNull();
  });

  it("uses the next post waiting on you only when it is Ready To Publish", () => {
    expect(nextAfterPublish({ ...base, myWork: { next: post("m") }, run: null })?.from).toBe("my-work");
    expect(nextAfterPublish({ ...base, myWork: { next: post("m", "Review") }, run: null })).toBeNull();
  });

  it("never offers the post being published", () => {
    expect(
      nextAfterPublish({ ...base, myWork: { next: post("a"), sameSource: true, siblings: [post("a")] }, run: null }),
    ).toBeNull();
  });
});
