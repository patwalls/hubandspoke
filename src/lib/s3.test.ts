import { describe, it, expect, beforeAll } from "vitest";

// Bucket-routing regression test. Source recordings now upload to Cloudflare
// R2 (multipart/create stamps r2BucketName()), and every downstream reader
// presigns a GET via getPresignedGetUrl(key, ttl, { bucket }). If the helper
// ever stops routing by bucket — or a reader omits the bucket — the URL is
// signed against the wrong host and the object 404s at download time
// (transcription, clipping, Descript cold-import all silently fail). These
// assertions lock the host the URL is signed against.
//
// Credentials are set before importing the module so getSignedUrl can sign
// fully offline (no network, no real AWS/R2 account needed).

const R2_HOST = "examplethis.r2.cloudflarestorage.com";

beforeAll(() => {
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST_S3";
  process.env.AWS_SECRET_ACCESS_KEY = "test-s3-secret";
  process.env.HUBANDSPOKE_S3_BUCKET = "hubandspoke-prod";
  process.env.R2_ENDPOINT = `https://${R2_HOST}`;
  process.env.R2_BUCKET = "hubandspoke-r2";
  process.env.R2_ACCESS_KEY_ID = "test-r2-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-r2-secret";
});

describe("getPresignedGetUrl bucket routing", () => {
  it("signs against the R2 endpoint when the object is in the R2 bucket", async () => {
    const { getPresignedGetUrl } = await import("./s3");
    const url = await getPresignedGetUrl("uploads/x/vid.mp4", 3600, {
      bucket: "hubandspoke-r2",
    });
    expect(new URL(url).host).toContain(R2_HOST);
  });

  it("signs against AWS S3 when no bucket is passed (legacy S3 rows)", async () => {
    const { getPresignedGetUrl } = await import("./s3");
    const url = await getPresignedGetUrl("uploads/x/vid.mp4", 3600);
    const host = new URL(url).host;
    expect(host).not.toContain(R2_HOST);
    expect(host).toContain("amazonaws.com");
  });
});
