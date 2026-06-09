import { describe, it, expect } from "vitest";
import { createTestProductionItem } from "@/test/factories";
import { findStaleYtItems } from "./yt-archive-watch";

const HOURS = 3600_000;
const DAYS = 24 * HOURS;

// The dev DB may contain real stale rows (it's a prod pull), so every
// assertion is membership of a specific test row, never a total count.
// limit is raised so ambient stale rows can't push test rows off the page.
async function staleIds(): Promise<Set<string>> {
  const rows = await findStaleYtItems(1000);
  return new Set(rows.map((r) => r.id));
}

describe("yt-archive-watch findStaleYtItems", () => {
  it("flags a published item with zero attempts past the grace window", async () => {
    const item = await createTestProductionItem({
      postType: "youtube_long",
      youtubeId: "auto",
      publishedAt: new Date(Date.now() - 24 * HOURS),
    });
    expect(await staleIds()).toContain(item.id);
  });

  it("ignores items already archived to S3", async () => {
    const item = await createTestProductionItem({
      postType: "youtube_long",
      youtubeId: "auto",
      publishedAt: new Date(Date.now() - 24 * HOURS),
      mediaS3Key: "hubandspoke/uploads/test/archived.mp4",
    });
    expect(await staleIds()).not.toContain(item.id);
  });

  it("ignores items the archiver already attempted (per-video failures aren't systemic)", async () => {
    const item = await createTestProductionItem({
      postType: "youtube_long",
      youtubeId: "auto",
      publishedAt: new Date(Date.now() - 24 * HOURS),
      youtubeDownloadAttempts: 1,
    });
    expect(await staleIds()).not.toContain(item.id);
  });

  it("ignores items still inside the grace window", async () => {
    const item = await createTestProductionItem({
      postType: "youtube_long",
      youtubeId: "auto",
      publishedAt: new Date(Date.now() - 1 * HOURS),
    });
    expect(await staleIds()).not.toContain(item.id);
  });

  it("ignores brands the home cron is not configured to archive", async () => {
    const item = await createTestProductionItem({
      brand: "hubspot-marketing",
      accountId: null,
      postType: "youtube_long",
      youtubeId: "auto",
      publishedAt: new Date(Date.now() - 24 * HOURS),
    });
    expect(await staleIds()).not.toContain(item.id);
  });

  it("ignores items older than the cron's own look-back window", async () => {
    const item = await createTestProductionItem({
      postType: "youtube_long",
      youtubeId: "auto",
      publishedAt: new Date(Date.now() - 45 * DAYS),
    });
    expect(await staleIds()).not.toContain(item.id);
  });

  it("ignores non-Published items", async () => {
    const item = await createTestProductionItem({
      status: "In Progress",
      postType: "youtube_long",
      youtubeId: "auto",
      publishedAt: new Date(Date.now() - 24 * HOURS),
    });
    expect(await staleIds()).not.toContain(item.id);
  });
});
