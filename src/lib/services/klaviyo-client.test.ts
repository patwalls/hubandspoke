/**
 * Unit tests for the Klaviyo HTTP client. No DB, no real network — fetch is
 * stubbed via `globalThis.fetch`. The integration test for the higher-level
 * sync lives at klaviyo-sync.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchKlaviyo,
  KlaviyoError,
  resolveKlaviyoApiKey,
} from "./klaviyo-client";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

beforeEach(() => {
  process.env = {
    ...originalEnv,
    KLAVIYO_API_KEY: undefined,
    KLAVIYO_API_KEY_STARTER_STORY_NEWSLETTER: undefined,
  };
});

describe("resolveKlaviyoApiKey", () => {
  it("prefers the per-handle env var over the global fallback", () => {
    process.env.KLAVIYO_API_KEY = "global-key";
    process.env.KLAVIYO_API_KEY_STARTER_STORY_NEWSLETTER = "per-handle-key";
    const key = resolveKlaviyoApiKey({ handle: "starter-story-newsletter" });
    expect(key).toBe("per-handle-key");
  });

  it("falls back to KLAVIYO_API_KEY when no per-handle var is set", () => {
    process.env.KLAVIYO_API_KEY = "global-key";
    const key = resolveKlaviyoApiKey({ handle: "some-other-handle" });
    expect(key).toBe("global-key");
  });

  it("throws a clear error naming both env var names when neither is set", () => {
    expect(() => resolveKlaviyoApiKey({ handle: "matg-newsletter" })).toThrow(
      /KLAVIYO_API_KEY_MATG_NEWSLETTER[\s\S]*KLAVIYO_API_KEY/,
    );
  });

  it("normalizes punctuation in the handle to underscores for the env name", () => {
    process.env.KLAVIYO_API_KEY_FOO_BAR_NL = "ok";
    expect(resolveKlaviyoApiKey({ handle: "foo.bar-nl" })).toBe("ok");
  });
});

describe("fetchKlaviyo", () => {
  const account = { handle: "starter-story-newsletter" };

  beforeEach(() => {
    process.env.KLAVIYO_API_KEY = "test-key";
  });

  it("sends the Klaviyo-API-Key header and the pinned revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/vnd.api+json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchKlaviyo(account, "/campaigns");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Klaviyo-API-Key test-key");
    expect(headers.Revision).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(headers.Accept).toBe("application/vnd.api+json");
  });

  it("returns null on 404 instead of throwing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;

    const out = await fetchKlaviyo(account, "/campaigns/missing");
    expect(out).toBeNull();
  });

  it("retries 429 responses honoring Retry-After, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate-limited", {
          status: 429,
          headers: { "retry-after": "0" }, // 0s so the test doesn't sleep
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchKlaviyo<{ ok: boolean }>(account, "/campaigns");
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws KlaviyoError after 3 failed attempts on 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("oops", { status: 500 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchKlaviyo(account, "/campaigns")).rejects.toBeInstanceOf(
      KlaviyoError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("throws KlaviyoError on a non-retryable 4xx without retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{"errors":[{"detail":"bad filter"}]}', { status: 400 }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchKlaviyo(account, "/campaigns")).rejects.toMatchObject({
      name: "KlaviyoError",
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
