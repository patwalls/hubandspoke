import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listWorkspaceLinks, updateLinkDestination, RebrandlyApiError } from "./rebrandly";

const link = (id: string, slashtag: string) => ({
  id,
  slashtag,
  shortUrl: `clickhubspot.com/${slashtag}`,
  destination: "https://offers.hubspot.com/x",
  title: `title ${id}`,
  favourite: false,
  clicks: 3,
  lastClickAt: "2026-10-09T10:00:00.000Z",
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("rebrandly client", () => {
  beforeEach(() => vi.stubEnv("REBRANDLY_API_KEY", "test-key"));
  afterEach(() => vi.unstubAllEnvs());

  it("lists every page of the workspace's clickhubspot.com links, with the workspace header", async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => link(`id${i}`, `mfm-k${i}`));
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(page1)).mockResolvedValueOnce(json([link("id25", "matg-aimarketer")]));
    const links = await listWorkspaceLinks(fetchImpl as unknown as typeof fetch);
    expect(links).toHaveLength(26);
    expect(links[25]).toMatchObject({ slashtag: "matg-aimarketer", clicks: 3, lastClickAt: "2026-10-09T10:00:00.000Z" });
    const [url1, init1] = fetchImpl.mock.calls[0];
    expect(url1).toContain("domain.id=8415698828d04a0b97b5ee83e3127011");
    expect(init1.headers).toMatchObject({ apikey: "test-key", workspace: "145af512bf064e498d1a578f9ac2bcf7" });
    expect(fetchImpl.mock.calls[1][0]).toContain("last=id24");
  });

  it("updates a link's destination, sending its own title + favourite (required by Rebrandly)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(link("abc", "mfm-ideavault")));
    await updateLinkDestination({ id: "abc", title: "MFM idea vault", favourite: true }, "https://offers.hubspot.com/new?utm_id=p1", fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.rebrandly.com/v1/links/abc");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ destination: "https://offers.hubspot.com/new?utm_id=p1", title: "MFM idea vault", favourite: true });
  });

  it("turns API errors into RebrandlyApiError, and a missing key into a 503", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ message: "Not found" }, 404));
    await expect(listWorkspaceLinks(fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ status: 404, message: "Rebrandly: Not found" });
    vi.stubEnv("REBRANDLY_API_KEY", "");
    await expect(listWorkspaceLinks(fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(RebrandlyApiError);
  });
});
