import { describe, expect, it } from "vitest";
import { extractS3Key } from "./media-actions";

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
