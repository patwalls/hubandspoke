import { describe, expect, it } from "vitest";
import { FailureThrottle, LOGIN_MAX_FAILS_PER_EMAIL, LOGIN_WINDOW_MS, clientIp, ipThrottleKey } from "./login-throttle";

describe("FailureThrottle (S-168)", () => {
  it("blocks after the limit and says how long, then frees the key when the window passes", () => {
    const t = new FailureThrottle(LOGIN_MAX_FAILS_PER_EMAIL, LOGIN_WINDOW_MS);
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_FAILS_PER_EMAIL - 1; i++) t.record("a@x.com", t0 + i);
    expect(t.blockedFor("a@x.com", t0 + 100)).toBe(0);
    t.record("a@x.com", t0 + 100);
    expect(t.blockedFor("a@x.com", t0 + 100)).toBeGreaterThan(14 * 60);
    expect(t.blockedFor("b@x.com", t0 + 100)).toBe(0);
    expect(t.blockedFor("a@x.com", t0 + LOGIN_WINDOW_MS + 101)).toBe(0);
  });

  it("is a sliding window — old failures age out one by one", () => {
    const t = new FailureThrottle(3, 1000);
    t.record("k", 0);
    t.record("k", 500);
    t.record("k", 900);
    expect(t.blockedFor("k", 950)).toBe(1); // until the 0ms hit expires at 1000
    expect(t.blockedFor("k", 1000)).toBe(0);
  });

  it("clear() resets a key (successful sign-in)", () => {
    const t = new FailureThrottle(1, 1000);
    t.record("k", 0);
    expect(t.blockedFor("k", 1)).toBeGreaterThan(0);
    t.clear("k");
    expect(t.blockedFor("k", 1)).toBe(0);
  });
});

describe("clientIp", () => {
  it("prefers Cloudflare's header", () => {
    expect(clientIp(new Headers({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))).toBe("1.2.3.4");
  });
  it("takes the LAST x-forwarded-for entry — the first is client-forgeable", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 5.6.7.8" }))).toBe("5.6.7.8");
  });
  it("falls back to one shared bucket", () => {
    expect(clientIp(new Headers())).toBe("unknown");
    expect(clientIp(undefined)).toBe("unknown");
  });
});

describe("ipThrottleKey", () => {
  it("throttles real client IPs but not loopback or unknown (e2e runs share one)", () => {
    expect(ipThrottleKey("5.6.7.8")).toBe("5.6.7.8");
    expect(ipThrottleKey("127.0.0.1")).toBeNull();
    expect(ipThrottleKey("::1")).toBeNull();
    expect(ipThrottleKey("::ffff:127.0.0.1")).toBeNull();
    expect(ipThrottleKey("unknown")).toBeNull();
  });
});
