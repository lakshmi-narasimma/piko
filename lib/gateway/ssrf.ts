/**
 * SSRF guard for seller upstream URLs. Piko fetches whatever base URL a seller lists, so a
 * Listing must not point at the server's own network: loopback, private ranges, link-local
 * (which holds the cloud metadata address 169.254.169.254), CGNAT and the like. The one
 * exception is the app's own `/api/demo` routes, where the seeded demo sellers live.
 *
 * `checkUpstreamUrl` resolves the hostname and refuses the URL if any address it resolves
 * to is blocked. Onboarding (lib/listings) calls it once. A hostname's DNS can change after
 * that (DNS rebinding), so the gateway should check again at forward time (P4-02).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Resolves a hostname to every address it has, like `dns.promises.lookup(h, { all: true })`. */
export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const defaultLookup: LookupFn = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export interface UpstreamUrlPolicy {
  /** APP_BASE_URL. URLs under `${appBaseUrl}/api/demo` are allowed without a DNS check. */
  appBaseUrl: string;
  lookup?: LookupFn;
}

export type UpstreamUrlRefusal =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "blocked_address"
  | "unresolvable_host";

export type UpstreamUrlCheck =
  | { ok: true; url: URL; demo: boolean }
  | { ok: false; reason: UpstreamUrlRefusal; message: string };

const DEMO_PATH = "/api/demo";

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast 255.255.255.255
] as const) {
  blockedV4.addSubnet(network, prefix, "ipv4");
}

const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6");
}

/** Expands an IPv6 address to its 8 groups as numbers. Assumes `isIP(ip) === 6`. */
function ipv6Groups(ip: string): number[] {
  let text = ip.split("%")[0]!.toLowerCase();
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two hex groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill =
    tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((group) => parseInt(group, 16));
}

function v4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * The IPv4 address an IPv6 address carries, for the forms that reach an IPv4 host:
 * IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4
 * (2002::/16). Null for any other IPv6 address.
 */
function embeddedIpv4(ip: string): string | null {
  const g = ipv6Groups(ip);
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return v4FromGroups(g[6]!, g[7]!);
  if (zeros(0, 6) && (g[6]! !== 0 || g[7]! > 1)) return v4FromGroups(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4FromGroups(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4FromGroups(g[1]!, g[2]!);
  return null;
}

/** True when an IP address is loopback, private, link-local or otherwise not public. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blockedV4.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4 !== null) return blockedV4.check(v4, "ipv4");
    return blockedV6.check(ip.split("%")[0]!, "ipv6");
  }
  // Not an IP address at all: refuse rather than guess.
  return true;
}

/** True for a URL on the app's own origin under `/api/demo`. */
export function isAppDemoUrl(url: URL, appBaseUrl: string): boolean {
  const app = new URL(appBaseUrl);
  if (url.origin !== app.origin) return false;
  const root = `${app.pathname.replace(/\/+$/, "")}${DEMO_PATH}`;
  return url.pathname === root || url.pathname.startsWith(`${root}/`);
}

function refuse(reason: UpstreamUrlRefusal, message: string): UpstreamUrlCheck {
  return { ok: false, reason, message };
}

/**
 * Checks that a seller's upstream URL is safe for Piko to fetch. The URL must be http or
 * https with no username or password, and its hostname must resolve only to public
 * addresses. URLs under the app's own `/api/demo` pass; any other URL on the app's own
 * origin is refused, so a Listing can't loop back into Piko.
 */
export async function checkUpstreamUrl(
  raw: string,
  policy: UpstreamUrlPolicy,
): Promise<UpstreamUrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("invalid_url", "The base URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refuse("unsupported_scheme", "The base URL must start with http:// or https://.");
  }
  if (url.username || url.password) {
    return refuse("credentials_in_url", "The base URL must not contain a username or password.");
  }
  if (isAppDemoUrl(url, policy.appBaseUrl)) return { ok: true, url, demo: true };
  if (url.origin === new URL(policy.appBaseUrl).origin) {
    return refuse("blocked_address", "The base URL can't point at Piko itself.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await (policy.lookup ?? defaultLookup)(host)).map((a) => a.address);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) {
      return refuse("unresolvable_host", `The host ${host} could not be resolved.`);
    }
  }
  if (addresses.some(isBlockedAddress)) {
    return refuse(
      "blocked_address",
      "The base URL points at a private, loopback or link-local address. Use a public URL.",
    );
  }
  return { ok: true, url, demo: false };
}
