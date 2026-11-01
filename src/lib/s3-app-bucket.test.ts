import { afterEach, describe, expect, it, vi } from "vitest";
import { isAppBucket } from "./s3";

// S-120: the cutout route presigned any bucket the request named.
describe("isAppBucket", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("accepts only the app's S3 and R2 buckets", () => {
    vi.stubEnv("HUBANDSPOKE_S3_BUCKET", "app-s3");
    vi.stubEnv("R2_BUCKET", "app-r2");
    expect(isAppBucket("app-s3")).toBe(true);
    expect(isAppBucket("app-r2")).toBe(true);
    expect(isAppBucket("someone-elses-bucket")).toBe(false);
  });
  it("an unset env var never matches an empty name", () => {
    vi.stubEnv("HUBANDSPOKE_S3_BUCKET", "");
    vi.stubEnv("R2_BUCKET", "");
    expect(isAppBucket("")).toBe(false);
  });
});
