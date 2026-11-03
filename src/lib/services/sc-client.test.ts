import { afterEach, describe, expect, it, vi } from "vitest";
import { SC_RETRY_DELAYS_MS, ScrapeCreatorsError, scFetchJson } from "./sc-client";

// Issue #139: SC 5xx are one-off upstream failures — retry them in-call.
// 4xx are real answers (bad handle, out of credits) and must not be retried.
describe("scFetchJson retries", () => {
  const saved = [...SC_RETRY_DELAYS_MS];
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    SC_RETRY_DELAYS_MS.splice(0, SC_RETRY_DELAYS_MS.length, ...saved);
  });

  function stub(statuses: number[]) {
    vi.stubEnv("SCRAPE_CREATORS_API_KEY", "test-key");
    SC_RETRY_DELAYS_MS.splice(0, SC_RETRY_DELAYS_MS.length, 0, 0);
    const spy = vi.fn(async () => {
      const status = statuses.shift() ?? 500;
      return status === 200
        ? new Response(JSON.stringify({ ok: true }), { status })
        : new Response("nope", { status });
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
