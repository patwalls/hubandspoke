/**
 * "Is this URL on the public internet?" — for any URL a user hands us that
 * the server then fetches (API webhooks, cloud cutout pictures). A hostname
 * blocklist is not enough (S-204): 172.16/12, 169.254/16, IPv6, decimal IPs
 * and DNS names that resolve to a private address all slip past a regex. So:
 *
 *  - `isPrivateAddress(ip)` classifies a literal IP (v4 or v6, incl.
 *    IPv4-mapped v6) with node's BlockList.
 *  - `assertPublicUrl(url)` resolves the host and refuses if ANY address is
 *    private — the friendly check at create time.
 *  - `publicOnlyDispatcher` is an undici Agent whose DNS lookup refuses
 *    private addresses at connect time, so a host that re-resolves to
 *    127.0.0.1 after the create-time check (DNS rebinding) still can't be
 *    reached. Pass it as `dispatcher` to undici's `fetch`.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { promises as dns } from "node:dns";
import { Agent } from "undici";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local / cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["64:ff9b::", 96], // NAT64 → v4
  ["2001:db8::", 32], // documentation
] as const) blocked.addSubnet(net, bits, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family === 6) {
    // ::ffff:10.0.0.1 — judge the embedded v4 address.
    const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    const hexMapped = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
    }
    return blocked.check(bare, "ipv6");
  }
  return true; // not an IP at all — refuse rather than guess
}

export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`${host} is not on the public internet`);
    this.name = "PrivateAddressError";
  }
}

/** Throws PrivateAddressError when the URL's host is, or resolves to, a
 *  private/loopback/link-local address. `resolve` is injectable for tests. */
export async function assertPublicUrl(
  raw: string | URL,
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address)
): Promise<void> {
  const url = typeof raw === "string" ? new URL(raw) : raw;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new PrivateAddressError(host);
  }
  // WHATWG URL already normalizes decimal/hex/octal v4 forms to dotted quads.
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => {
    throw new PrivateAddressError(host);
  });
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new PrivateAddressError(host);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup that refuses private answers — undici calls it on every connect. */
export function publicOnlyLookup(hostname: string, options: object, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) return callback(Object.assign(new PrivateAddressError(hostname), { code: "EPRIVATE" }), []);
    const wantsAll = (options as { all?: boolean }).all;
    if (wantsAll) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** undici dispatcher for server-side fetches of user-supplied URLs. IP-literal
 *  hosts skip DNS, so callers must also run `assertPublicUrl` first. */
export const publicOnlyDispatcher = new Agent({ connect: { lookup: publicOnlyLookup } });
