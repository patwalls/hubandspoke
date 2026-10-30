import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApiKey, createTestUser } from "@/test/factories";

// The session fallback calls next-auth's auth(), which needs a request scope.
// Stub it so "no key, no session" is testable here; the key path never calls it.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (fn: () => unknown) => void fn() };
});

const { authenticateApi } = await import("./auth");
const { ApiError } = await import("./http");
const { recordApiRequest, touchApiKey, listRecentApiRequests, listApiKeys, revokeApiKey } = await import("./keys");

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/v1/me", { headers });
}

async function expectApiError(p: Promise<unknown>, type: string, messagePart?: string) {
  try {
    await p;
    throw new Error("expected an ApiError");
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as InstanceType<typeof ApiError>).type).toBe(type);
    if (messagePart) expect((e as Error).message).toContain(messagePart);
  }
}

describe("authenticateApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves a Bearer key to its owner and names the key", async () => {
    const user = await createTestUser({ role: "creator" });
    const { key, row } = await createTestApiKey({ userId: user.id, name: "Zapier" });
    const p = await authenticateApi(req({ authorization: `Bearer ${key}` }));
    expect(p.auth).toBe("api_key");
    expect(p.user.id).toBe(user.id);
    expect(p.user.role).toBe("creator");
    expect(p.key?.id).toBe(row.id);
    expect(p.key?.name).toBe("Zapier");
    expect(p.rateLimit.limit).toBeGreaterThan(0);
  });

  it("also accepts X-API-Key", async () => {
    const user = await createTestUser();
    const { key } = await createTestApiKey({ userId: user.id });
    const p = await authenticateApi(req({ "x-api-key": key }));
    expect(p.user.id).toBe(user.id);
  });

  it("401s with a precise reason: unknown, revoked, expired, deactivated owner", async () => {
    const user = await createTestUser();
    const unknown = (await createTestApiKey({ userId: user.id })).key.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
    await expectApiError(authenticateApi(req({ authorization: `Bearer ${unknown}` })), "unauthorized", "Invalid API key");

    const revoked = await createTestApiKey({ userId: user.id, revokedAt: new Date() });
    await expectApiError(authenticateApi(req({ authorization: `Bearer ${revoked.key}` })), "unauthorized", "revoked");

    const expired = await createTestApiKey({ userId: user.id, expiresAt: new Date(Date.now() - 1000) });
    await expectApiError(authenticateApi(req({ authorization: `Bearer ${expired.key}` })), "unauthorized", "expired");

    const gone = await createTestUser({ deactivated: true });
    const goneKey = await createTestApiKey({ userId: gone.id });
    await expectApiError(authenticateApi(req({ authorization: `Bearer ${goneKey.key}` })), "unauthorized", "deactivated");
  });

  it("401s when there is neither a key nor a session", async () => {
    await expectApiError(authenticateApi(req()), "unauthorized", "Missing API key");
    await expectApiError(authenticateApi(req({ authorization: "Basic abc" })), "unauthorized");
  });

  it("revoking cuts access immediately and keeps the row for history", async () => {
    const user = await createTestUser();
    const { key, row } = await createTestApiKey({ userId: user.id });
    await authenticateApi(req({ authorization: `Bearer ${key}` }));
    expect(await revokeApiKey({ keyId: row.id, userId: user.id })).toBe(true);
    expect(await revokeApiKey({ keyId: row.id, userId: user.id })).toBe(false); // already revoked
    await expectApiError(authenticateApi(req({ authorization: `Bearer ${key}` })), "unauthorized", "revoked");
    const mine = await listApiKeys(user.id);
    expect(mine.find((k) => k.id === row.id)?.revokedAt).toBeTruthy();
  });

  it("someone else cannot revoke my key unless they are an admin", async () => {
    const me = await createTestUser();
    const other = await createTestUser();
    const { row } = await createTestApiKey({ userId: me.id });
    expect(await revokeApiKey({ keyId: row.id, userId: other.id })).toBe(false);
    expect(await revokeApiKey({ keyId: row.id, userId: other.id, isAdmin: true })).toBe(true);
  });

  it("request logs attach to the key and bump its counters", async () => {
    const user = await createTestUser();
    const { row } = await createTestApiKey({ userId: user.id });
    await recordApiRequest({
      apiKeyId: row.id,
      userId: user.id,
      source: "rest",
      method: "GET",
      route: "/v1/content",
      status: 200,
      durationMs: 12.6,
    });
    await touchApiKey(row.id);
    const [k] = await listApiKeys(user.id);
    expect(k.requestCount).toBe(1);
    expect(k.lastUsedAt).toBeTruthy();
    const recent = await listRecentApiRequests({ userId: user.id });
    expect(recent[0]).toMatchObject({ route: "/v1/content", status: 200, durationMs: 13, key: { id: row.id } });
    // Another user sees none of mine unless asking for everyone as an admin.
    const other = await createTestUser();
    expect(await listRecentApiRequests({ userId: other.id })).toHaveLength(0);
    expect((await listRecentApiRequests({ userId: other.id, all: true })).some((r) => r.key?.id === row.id)).toBe(true);
  });
});
