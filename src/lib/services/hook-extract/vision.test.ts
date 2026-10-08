import { describe, it, expect, vi, afterEach } from "vitest";

// loadPosterImageBlock is the one place both hook sweeps (vision + the
// unified dispatcher) turn an S3 poster into a Claude image block. The
// contract that matters: permanent problems come back as `{ skip }` so the
// caller stamps the row and moves on, while transient failures THROW so
// graphile retries. Getting that backwards either loops a dead poster
// through 25 attempts every sweep (HUBANDSPOKE-V) or silently drops a hook
// on a network blip.

vi.mock("@/lib/s3", () => ({
  getPresignedGetUrl: vi.fn(async (key: string) => `https://s3.test/${key}?sig=1`),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/services/content-revisions", () => ({ recordContentChanges: vi.fn() }));

function stubFetch(status: number, bytes = 16) {
  const fetchMock = vi.fn(async () => new Response(new Uint8Array(bytes), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadPosterImageBlock", () => {
  it("returns a base64 image block with the media type from the key", async () => {
    stubFetch(200, 4);
    const { loadPosterImageBlock } = await import("./vision");
    const out = await loadPosterImageBlock("posters/a/cover.JPG");
    expect(out).toEqual({
      block: {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "AAAAAA==" },
      },
    });
  });

  it("skips without fetching when the extension isn't a supported image", async () => {
    const fetchMock = stubFetch(200);
    const { loadPosterImageBlock } = await import("./vision");
    expect(await loadPosterImageBlock("posters/a/cover.heic")).toEqual({
      skip: "non-image-poster",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips (permanent) when the object is missing", async () => {
    stubFetch(404);
    const { loadPosterImageBlock } = await import("./vision");
    expect(await loadPosterImageBlock("posters/a/cover.png")).toEqual({
      skip: "poster-fetch-404",
    });
  });

  it("skips posters over Claude's 5 MB image cap", async () => {
    stubFetch(200, 5 * 1024 * 1024 + 1);
    const { loadPosterImageBlock } = await import("./vision");
    expect(await loadPosterImageBlock("posters/a/cover.webp")).toEqual({
      skip: "poster-too-large",
    });
  });

  it("throws on a 5xx so the job retries", async () => {
    stubFetch(503);
    const { loadPosterImageBlock } = await import("./vision");
    await expect(loadPosterImageBlock("posters/a/cover.png")).rejects.toThrow(
      /HTTP 503/
    );
  });
});
