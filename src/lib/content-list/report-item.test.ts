import { describe, it, expect } from "vitest";
import type { ProductionItem } from "@/types";
import { reportCoverKeys, slimReportItem } from "./report-item";

function item(over: Partial<ProductionItem>): ProductionItem {
  return {
    id: "i1",
    title: "A post",
    thumbnail: null,
    account: null,
    accountId: "a1",
    ...over,
  } as ProductionItem;
}

describe("reportCoverKeys", () => {
  it("signs posters and image media, never archived video", () => {
    const keys = reportCoverKeys([
      item({ posterS3Key: "p1", mediaS3Key: "v1.mp4", mediaContentType: "video/mp4" }),
      item({ mediaS3Key: "v2.mp4", mediaContentType: "video/mp4" }),
      item({ mediaS3Key: "photo.jpg", mediaContentType: "image/jpeg" }),
      item({ posterS3Key: "p3", mediaS3Key: "photo3.jpg", mediaContentType: "image/jpeg" }),
    ]);
    expect([...keys].sort()).toEqual(["p1", "p3", "photo.jpg"]);
  });
});

describe("slimReportItem", () => {
  it("ships one resolved cover and none of its sources", () => {
    const row = slimReportItem(
      item({
        posterUrl: "https://s3/poster?sig",
        mediaUrl: "https://s3/video?sig",
        thumbnail: "https://cdninstagram/long",
        posterS3Key: "p1",
        mediaS3Key: "v1",
        hook: "a hook",
      }),
    ) as Record<string, unknown>;
    expect(row.posterUrl).toBe("https://s3/poster?sig");
    for (const k of ["mediaUrl", "thumbnail", "posterS3Key", "mediaS3Key", "hook", "account"]) {
      expect(row).not.toHaveProperty(k);
    }
  });

  it("an image post's cover is its archived image, not the expiring CDN thumbnail", () => {
    const row = slimReportItem(
      item({
        mediaUrl: "https://s3/photo?sig",
        mediaContentType: "image/jpeg",
        thumbnail: "https://cdninstagram/expires",
      }),
    );
    expect(row.posterUrl).toBe("https://s3/photo?sig");
    expect(row).not.toHaveProperty("mediaContentType");
  });

  it("falls back to the thumbnail when nothing is archived", () => {
    const row = slimReportItem(item({ thumbnail: "https://i.ytimg.com/x.jpg" }));
    expect(row.posterUrl).toBe("https://i.ytimg.com/x.jpg");
  });

  it("no cover at all leaves no posterUrl key", () => {
    expect(slimReportItem(item({}))).not.toHaveProperty("posterUrl");
  });
});
