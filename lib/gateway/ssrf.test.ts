import { describe, expect, it, vi } from "vitest";
import {
  checkUpstreamUrl,
  isAppDemoUrl,
  isBlockedAddress,
  LOOKUP_TIMEOUT_MS,
  type LookupFn,
} from "./ssrf";

const APP = "https://piko.test";

function resolvesTo(...addresses: string[]): LookupFn {
  return vi.fn(async () => addresses.map((address) => ({ address, family: 4 })));
}

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.10.0.5",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111"])(
    "allows %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe("isAppDemoUrl", () => {
  it("matches only /api/demo/sellers/ on the app's origin", () => {
    expect(isAppDemoUrl(new URL("https://piko.test/api/demo/sellers/x"), APP)).toBe(true);
    expect(isAppDemoUrl(new URL("https://piko.test/api/demo/sellers"), APP)).toBe(false);
    expect(isAppDemoUrl(new URL("https://piko.test/api/demo/sellers-x/y"), APP)).toBe(false);
    expect(isAppDemoUrl(new URL("https://piko.test/api/demo"), APP)).toBe(false);
    expect(isAppDemoUrl(new URL("https://piko.test/api/demo/simulate"), APP)).toBe(false);
    expect(isAppDemoUrl(new URL("https://piko.test/api/demolition"), APP)).toBe(false);
    expect(isAppDemoUrl(new URL("https://piko.test/api/demo/sellers/../../pay"), APP)).toBe(false);
    expect(isAppDemoUrl(new URL("http://piko.test/api/demo/sellers/x"), APP)).toBe(false);
    expect(isAppDemoUrl(new URL("https://evil.test/api/demo/sellers/x"), APP)).toBe(false);
  });
});

describe("checkUpstreamUrl", () => {
  it("allows a public host", async () => {
    const lookup = resolvesTo("93.184.216.34");
    const result = await checkUpstreamUrl("https://api.seller.example/v1", {
      appBaseUrl: APP,
      lookup,
    });
    expect(result).toMatchObject({ ok: true, demo: false });
    expect(lookup).toHaveBeenCalledWith("api.seller.example");
  });

  it("allows the app's own /api/demo URLs without resolving them", async () => {
    const lookup = resolvesTo("127.0.0.1");
    const result = await checkUpstreamUrl("https://piko.test/api/demo/sellers/price-history", {
      appBaseUrl: APP,
      lookup,
    });
    expect(result).toMatchObject({ ok: true, demo: true });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("allows /api/demo on a localhost app base URL", async () => {
    const result = await checkUpstreamUrl("http://localhost:3000/api/demo/sellers/x", {
      appBaseUrl: "http://localhost:3000",
    });
    expect(result).toMatchObject({ ok: true, demo: true });
  });

  it.each(["https://piko.test/g/priya", "https://piko.test/api/demo/simulate"])(
    "refuses the rest of the app's own origin: %s",
    async (raw) => {
      const result = await checkUpstreamUrl(raw, {
        appBaseUrl: APP,
        lookup: resolvesTo("93.184.216.34"),
      });
      expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
    },
  );

  it.each([
    "https://api.seller.example:8443",
    "http://api.seller.example:22",
    "http://8.8.8.8:6379",
  ])("refuses a non-web port: %s", async (raw) => {
    const lookup = resolvesTo("93.184.216.34");
    const result = await checkUpstreamUrl(raw, { appBaseUrl: APP, lookup });
    expect(result).toMatchObject({ ok: false, reason: "blocked_port" });
  });

  it.each([
    "http://api.seller.example:80",
    "https://api.seller.example:443",
    "http://api.seller.example:443",
  ])("allows web port %s", async (raw) => {
    const result = await checkUpstreamUrl(raw, {
      appBaseUrl: APP,
      lookup: resolvesTo("93.184.216.34"),
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("gives up on a DNS lookup that takes too long", async () => {
    vi.useFakeTimers();
    try {
      const lookup: LookupFn = vi.fn(() => new Promise<never>(() => {}));
      const pending = checkUpstreamUrl("https://slow.seller.example", { appBaseUrl: APP, lookup });
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
      await expect(pending).resolves.toMatchObject({ ok: false, reason: "unresolvable_host" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "http://127.0.0.1",
    "http://localhost/api/demo",
    "http://10.1.2.3",
    "http://192.168.0.10/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://2130706433/",
    "http://0x7f.1/",
  ])("refuses %s", async (raw) => {
    const result = await checkUpstreamUrl(raw, {
      appBaseUrl: APP,
      lookup: resolvesTo("127.0.0.1"),
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const result = await checkUpstreamUrl("https://internal.seller.example", {
      appBaseUrl: APP,
      lookup: resolvesTo("10.0.0.7"),
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("refuses a hostname when any one of its addresses is private", async () => {
    const result = await checkUpstreamUrl("https://mixed.seller.example", {
      appBaseUrl: APP,
      lookup: resolvesTo("93.184.216.34", "169.254.169.254"),
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("refuses a hostname that does not resolve", async () => {
    const lookup: LookupFn = vi.fn(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const result = await checkUpstreamUrl("https://nowhere.invalid", { appBaseUrl: APP, lookup });
    expect(result).toMatchObject({ ok: false, reason: "unresolvable_host" });
  });

  it.each([
    ["ftp://seller.example", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["gopher://seller.example", "unsupported_scheme"],
    ["https://user:pass@seller.example", "credentials_in_url"],
    ["not a url", "invalid_url"],
  ])("refuses %s as %s", async (raw, reason) => {
    const result = await checkUpstreamUrl(raw, {
      appBaseUrl: APP,
      lookup: resolvesTo("93.184.216.34"),
    });
    expect(result).toMatchObject({ ok: false, reason });
  });
});
