import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SC_RETRY_DELAYS_MS,
  ScrapeCreatorsError,
  isScContentGoneBody,
  scFetchJson,
  scGetWithRetry,
} from "./sc-client";

// Issue #139: SC 5xx are one-off upstream failures — retry them in-call.
// 4xx are real answers (bad handle, out of credits) and must not be retried.
describe("scFetchJson retries", () => {
  const saved = [...SC_RETRY_DELAYS_MS];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    SC_RETRY_DELAYS_MS.splice(0, SC_RETRY_DELAYS_MS.length, ...saved);
  });

  function stub(statuses: number[], errorBody = "nope") {
    vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
    SC_RETRY_DELAYS_MS.splice(0, SC_RETRY_DELAYS_MS.length, 0, 0);
    const spy = vi.fn(async () => {
      const status = statuses.shift() ?? 500;
      return status === 200
        ? new Response(JSON.stringify({ ok: true }), { status })
        : new Response(errorBody, { status });
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("succeeds after a 500 then a 503", async () => {
    const spy = stub([500, 503, 200]);
    await expect(scFetchJson("/v1/x")).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retries with a ScrapeCreatorsError carrying the status", async () => {
    const spy = stub([500, 500, 500, 200]);
    const err = (await scFetchJson("/v1/x").catch((e: unknown) => e)) as ScrapeCreatorsError;
    expect(err).toBeInstanceOf(ScrapeCreatorsError);
    expect(err.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("never retries a 4xx", async () => {
    const spy = stub([402, 200]);
    await expect(scFetchJson("/v1/x")).rejects.toThrow(/402/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("still maps 404 to null without retrying", async () => {
    const spy = stub([404]);
    await expect(scFetchJson("/v1/x")).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// HUBANDSPOKE-84: SC answers a deleted/private YouTube video with a 500 whose
// body says "This video is unavailable". Bodies below are verbatim from prod
// production_items.enrichment_error (2026-11-22).
const GONE_500 =
  '{"success":false,"credits_remaining":236147,"credits_charged":0,"error":"internal_server_error","errorStatus":500,"message":"This video is unavailable"}';

describe("SC content-gone 5xx", () => {
  const saved = [...SC_RETRY_DELAYS_MS];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    SC_RETRY_DELAYS_MS.splice(0, SC_RETRY_DELAYS_MS.length, ...saved);
  });

  function stubBody(status: number, body: string) {
    vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
    SC_RETRY_DELAYS_MS.splice(0, SC_RETRY_DELAYS_MS.length, 0, 0);
    const spy = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("scFetchJson maps it to null without retrying", async () => {
    const spy = stubBody(500, GONE_500);
    await expect(scFetchJson("/v1/youtube/video")).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("scGetWithRetry without nullOn404 throws a 404-status error", async () => {
    const spy = stubBody(500, GONE_500);
    const err = (await scGetWithRetry("/v1/youtube/video").catch((e: unknown) => e)) as ScrapeCreatorsError;
    expect(err).toBeInstanceOf(ScrapeCreatorsError);
    expect(err.status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("still retries a real transient 503 that says Service Unavailable", async () => {
    const spy = stubBody(503, '{"message":"Service Unavailable"}');
    await expect(scFetchJson("/v1/instagram/post")).rejects.toMatchObject({ status: 503 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it.each([
    [GONE_500, true],
    ['{"message":"This post is private"}', true],
    ['{"message":"This video has been removed"}', true],
    ['{"message":"Service Unavailable"}', false],
    ['{"message":"Internal Server Error"}', false],
    ["<html>502 Bad Gateway</html>", false],
    ["", false],
  ])("isScContentGoneBody(%s) = %s", (body, expected) => {
    expect(isScContentGoneBody(body)).toBe(expected);
  });
});
