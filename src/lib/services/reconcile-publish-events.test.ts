import { describe, it, expect } from "vitest";
import {
  isNoopStatusChange,
  reconcilePublishChanges,
} from "./reconcile-publish-events";

const synced = {
  publishedLink: "https://www.instagram.com/p/abc/",
  publishedDate: "2026-11-25",
};

describe("reconcilePublishChanges", () => {
  it("records the flip when the planning item was still Scheduled", () => {
    const r = reconcilePublishChanges(
      { status: "Scheduled", publishedLink: null, publishedDate: null },
      synced,
    );
    expect(r.statusChange).toEqual({ from: "Scheduled", to: "Published" });
    expect(r.changes.map((c) => c.target)).toEqual([
      { kind: "production_item_field", field: "status" },
      { kind: "production_item_field", field: "publishedLink" },
      { kind: "production_item_field", field: "publishedDate" },
    ]);
  });

  // Prod 2026-11-25: the link was pasted (status → Published), the sync then
  // matched the live post and wrote "from Published to Published".
  it("records no status change when the item is already Published", () => {
    const r = reconcilePublishChanges(
      {
        status: "Published",
        publishedLink: "https://instagram.com/p/abc",
        publishedDate: "2026-11-25",
      },
      synced,
    );
    expect(r.statusChange).toBeNull();
    // The link the sync knows still replaces the pasted one.
    expect(r.changes.map((c) => c.target)).toEqual([
      { kind: "production_item_field", field: "publishedLink" },
    ]);
  });
});

describe("isNoopStatusChange", () => {
  it("is true only for a status_change to the same status", () => {
    expect(isNoopStatusChange({ type: "status_change", from: "Published", to: "Published" })).toBe(true);
    expect(isNoopStatusChange({ type: "status_change", from: "Ready To Publish", to: "Published" })).toBe(false);
    expect(isNoopStatusChange({ type: "status_change", from: null, to: null })).toBe(false);
    expect(isNoopStatusChange({ type: "editor_change", from: "A", to: "A" })).toBe(false);
  });
});
