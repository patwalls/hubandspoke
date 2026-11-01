import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateAddress } from "./public-url";

describe("isPrivateAddress (S-204)", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "::1", "[::1]", "fd12:3456::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe",
  ])("%s is private", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "172.32.0.1", "104.16.0.1", "2606:4700::1111"])("%s is public", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false));
});

describe("assertPublicUrl", () => {
  const resolvesTo = (...ips: string[]) => async () => ips;

  it("passes a host that resolves to public addresses", async () => {
    await expect(assertPublicUrl("https://hooks.example.com/x", resolvesTo("93.184.216.34"))).resolves.toBeUndefined();
  });

  it("refuses a DNS name that resolves to a private address — the regex blocklist missed this", async () => {
    await expect(assertPublicUrl("https://evil.example.com/x", resolvesTo("93.184.216.34", "169.254.169.254"))).rejects.toThrow(/public internet/);
  });

  it.each([
    "https://172.20.0.5/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/hook",
    "https://[fd00::1]/hook",
    "https://2130706433/hook", // decimal 127.0.0.1
    "https://0x7f000001/hook", // hex 127.0.0.1
    "https://localhost/hook",
    "https://printer.local/hook",
  ])("refuses %s without asking DNS", async (url) => {
    await expect(assertPublicUrl(url, async () => { throw new Error("should not resolve"); })).rejects.toThrow(/public internet/);
  });

  it("refuses a host that doesn't resolve", async () => {
    await expect(assertPublicUrl("https://nope.invalid/", async () => { throw new Error("ENOTFOUND"); })).rejects.toThrow(/public internet/);
  });
});
