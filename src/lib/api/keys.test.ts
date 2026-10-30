import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  apiKeyProblem,
  displayPrefix,
  generateApiKeySecret,
  hashApiKey,
  looksLikeApiKey,
  type ResolvedApiKey,
} from "./keys";

describe("api key secrets", () => {
  it("generates hs_live_ keys of a fixed shape that pass the pre-check", () => {
    const key = generateApiKeySecret();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(API_KEY_PREFIX.length + 32);
    expect(looksLikeApiKey(key)).toBe(true);
    expect(generateApiKeySecret()).not.toBe(key);
  });

  it("rejects near-misses before touching the DB", () => {
    expect(looksLikeApiKey("hs_live_short")).toBe(false);
    expect(looksLikeApiKey("sk_live_" + "a".repeat(32))).toBe(false);
    expect(looksLikeApiKey(API_KEY_PREFIX + "a".repeat(31) + "!")).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
  });

  it("hashes deterministically and never stores the key itself", () => {
    const key = generateApiKeySecret();
    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).not.toContain(key.slice(API_KEY_PREFIX.length));
  });

  it("shows only the prefix plus eight characters", () => {
    const key = API_KEY_PREFIX + "ABCDEFGHijklmnopqrstuvwxyz012345";
    expect(displayPrefix(key)).toBe("hs_live_ABCDEFGH");
  });
});

describe("apiKeyProblem", () => {
  const base: ResolvedApiKey = {
    key: {
      id: "k",
      userId: "u",
      name: "n",
      keyPrefix: "p",
      keyHash: "h",
      scopes: ["read"],
      lastUsedAt: null,
      requestCount: 0,
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    user: { id: "u", email: "a@b.c", name: null, role: "creator", deactivatedAt: null },
  };
  const now = new Date("2026-10-30T00:00:00Z");

  it("is fine for a live key on an active user", () => {
    expect(apiKeyProblem(base, now)).toBeNull();
  });
  it("revoked wins over everything else", () => {
    expect(
      apiKeyProblem(
        { ...base, key: { ...base.key, revokedAt: now, expiresAt: new Date("2020-01-01") } },
        now,
      ),
    ).toBe("revoked");
  });
  it("an expiry in the past (or right now) is expired; in the future is fine", () => {
    expect(apiKeyProblem({ ...base, key: { ...base.key, expiresAt: now } }, now)).toBe("expired");
    expect(apiKeyProblem({ ...base, key: { ...base.key, expiresAt: new Date(now.getTime() + 1) } }, now)).toBeNull();
  });
  it("a deactivated owner blocks the key even if the key itself is fine", () => {
    expect(apiKeyProblem({ ...base, user: { ...base.user, deactivatedAt: now } }, now)).toBe("user_deactivated");
  });
});
