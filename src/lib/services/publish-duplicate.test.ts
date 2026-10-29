import { describe, it, expect } from "vitest";
import { publishDuplicateAction } from "./publish-duplicate";
import type { DuplicateMatch } from "./production-items-dedup";

const dup = (accountId: string | null): DuplicateMatch => ({
  id: "synced-row",
  accountId,
  accountHandle: "brand_ig",
  platformContentId: "ABC123",
  publishedLink: "https://www.instagram.com/reel/ABC123/",
});

describe("publishDuplicateAction", () => {
  it("stores the key when nothing else owns it", () => {
    expect(publishDuplicateAction("acct-1", null)).toEqual({ kind: "none" });
  });

  it("folds the account sync's copy of the same post into the planned item", () => {
    expect(publishDuplicateAction("acct-1", dup("acct-1"))).toEqual({
      kind: "merge",
      duplicateId: "synced-row",
    });
  });

  it("refuses a post that lives on another account", () => {
    expect(publishDuplicateAction("acct-1", dup("acct-2")).kind).toBe("conflict");
    expect(publishDuplicateAction("acct-1", dup(null)).kind).toBe("conflict");
  });

  it("publishes an item with no account without the key, as before", () => {
    expect(publishDuplicateAction(null, dup("acct-1"))).toEqual({ kind: "skip-key" });
  });
});
