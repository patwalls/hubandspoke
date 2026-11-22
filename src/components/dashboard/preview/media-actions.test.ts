import { describe, expect, it } from "vitest";
import { extractS3Key, mediaFilename } from "./media-actions";

describe("extractS3Key", () => {
  it("parses path-style URLs (s3.us-east-1.amazonaws.com/<bucket>/<key>)", () => {
    const url =
      "https://s3.us-east-1.amazonaws.com/hubandspoke-prod/hubandspoke/uploads/abc-123/file.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&foo=bar";
    expect(extractS3Key(url)).toBe(
      "hubandspoke/uploads/abc-123/file.jpg",
    );
  });

  it("parses virtual-hosted-style URLs (<bucket>.s3.us-east-1.amazonaws.com/<key>)", () => {
    const url =
      "https://hubandspoke-prod.s3.us-east-1.amazonaws.com/hubandspoke/uploads/abc-123/file.mp4?X-Amz-Signature=xyz";
    expect(extractS3Key(url)).toBe(
      "hubandspoke/uploads/abc-123/file.mp4",
    );
  });

  it("preserves nested key segments", () => {
    const url =
      "https://s3.us-east-1.amazonaws.com/bucket/a/b/c/d/file.png";
    expect(extractS3Key(url)).toBe("a/b/c/d/file.png");
  });

  it("returns null for non-S3 URLs", () => {
    expect(extractS3Key("https://hubandspoke.starterstory.com/foo")).toBeNull();
    expect(extractS3Key("https://example.com/anything")).toBeNull();
  });

  it("returns null for unparseable URLs", () => {
    expect(extractS3Key("not-a-url")).toBeNull();
    expect(extractS3Key("")).toBeNull();
  });

  it("returns null for an S3 URL with no key segment", () => {
    // bucket only, no object key
    expect(
      extractS3Key("https://s3.us-east-1.amazonaws.com/bucket"),
    ).toBeNull();
  });
});

describe("mediaFilename", () => {
  it("names a single download by kind with the blob's extension", () => {
    expect(mediaFilename("image/jpeg", "image")).toBe("image.jpeg");
    expect(mediaFilename("video/mp4; codecs=avc1", "video")).toBe("video.mp4");
  });

  it("falls back to png / mp4 when the blob has no usable type", () => {
    expect(mediaFilename("", "image")).toBe("image.png");
    expect(mediaFilename("application/", "video")).toBe("video.mp4");
  });

  it("numbers carousel slides so they sort in post order", () => {
    expect(mediaFilename("image/png", "image", { n: 1, total: 6 })).toBe("slide-01.png");
    // Without padding "slide-10" would sort before "slide-2" in a file picker.
    expect(mediaFilename("image/png", "image", { n: 10, total: 10 })).toBe("slide-10.png");
    expect(mediaFilename("video/mp4", "video", { n: 3, total: 4 })).toBe("slide-03.mp4");
  });

  it("pads to the carousel's width past 99 slides", () => {
    expect(mediaFilename("image/png", "image", { n: 7, total: 120 })).toBe("slide-007.png");
  });
});
