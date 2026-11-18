import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { clerkJwtKey, isLanOrigin, loadConfig, originChecker } from "../src/config.js";
import { rateLimitAddress, rateLimitKey } from "../src/app.js";

const base = { POSTGRES_CONNECTION_STRING: "x", CLERK_PUBLISHABLE_KEY: "x", CLERK_SECRET_KEY: "x" };

describe("isLanOrigin", () => {
  test("accepts private-network addresses and .local names", () => {
    for (const origin of [
      "http://192.168.0.102:5173",
      "http://10.0.0.5:5173",
      "http://172.16.4.2",
      "http://172.31.255.255:8080",
      "https://demnas-macbook-pro.local:5173",
    ]) {
      assert.equal(isLanOrigin(origin), true, origin);
    }
  });

  test("rejects public hosts, lookalikes and other schemes", () => {
    for (const origin of [
      "https://gambitio.com",
      "http://172.32.0.1:5173",
      "http://172.15.0.1:5173",
      "http://8.8.8.8",
      "http://192.168.0.evil.com",
      "http://local:5173",
      "file://192.168.0.2",
      "not a url",
    ]) {
      assert.equal(isLanOrigin(origin), false, origin);
    }
  });
});

describe("originChecker", () => {
  test("allows only the listed origins by default", () => {
    const allowed = originChecker(
      loadConfig({ ...base, EXTRA_FRONTEND_ORIGINS: "http://phone.test:5173" })
    );
    assert.equal(allowed("http://localhost:5173"), true);
    assert.equal(allowed("http://phone.test:5173"), true);
    assert.equal(allowed("http://192.168.0.102:5173"), false);
  });

  test("ALLOW_LAN_ORIGINS adds private-network origins, nothing else", () => {
    const allowed = originChecker(loadConfig({ ...base, ALLOW_LAN_ORIGINS: "true" }));
    assert.equal(allowed("http://localhost:5173"), true);
    assert.equal(allowed("http://192.168.0.102:5173"), true);
    assert.equal(allowed("https://evil.example"), false);
  });

  test("ALLOW_LAN_ORIGINS is off unless set to true or 1", () => {
    for (const value of [undefined, "", "false", "0", "yes"]) {
      const allowed = originChecker(loadConfig({ ...base, ALLOW_LAN_ORIGINS: value }));
      assert.equal(allowed("http://192.168.0.102:5173"), false, String(value));
    }
  });

  test("ALLOW_LAN_ORIGINS can't be enabled in production", () => {
    assert.throws(
      () => loadConfig({ ...base, NODE_ENV: "production", ALLOW_LAN_ORIGINS: "true" }),
      /ALLOW_LAN_ORIGINS/
    );
    const config = { ...loadConfig({ ...base, NODE_ENV: "production" }), ALLOW_LAN_ORIGINS: true };
    assert.equal(originChecker(config)("http://192.168.0.102:5173"), false);
  });
});

describe("parsePgDuration", async () => {
  const { parsePgDuration } = await import("../src/db.js");
  test("reads the units SHOW uses", () => {
    assert.equal(parsePgDuration("5s"), 5_000);
    assert.equal(parsePgDuration("5000ms"), 5_000);
    assert.equal(parsePgDuration("10s"), 10_000);
    assert.equal(parsePgDuration("1min"), 60_000);
    assert.equal(parsePgDuration("0"), 0);
    assert.equal(parsePgDuration("off"), null);
  });
});

describe("CLERK_JWT_KEY", () => {
  const pem = (modulusLength = 2048) =>
    generateKeyPairSync("rsa", { modulusLength }).publicKey.export({ type: "spki", format: "pem" }).toString();

  test("is optional", () => {
    assert.equal(loadConfig(base).CLERK_JWT_KEY, undefined);
    assert.equal(loadConfig({ ...base, CLERK_JWT_KEY: "  " }).CLERK_JWT_KEY, undefined);
  });

  test("accepts the PEM as pasted, with \\n escapes, or flattened onto one line", () => {
    const key = pem();
    assert.equal(loadConfig({ ...base, CLERK_JWT_KEY: key }).CLERK_JWT_KEY, key.trim());
    assert.equal(clerkJwtKey(key.trim().replace(/\n/g, "\\n")), key.trim());
    assert.equal(clerkJwtKey(key.trim().replace(/\n/g, " ")), key.trim());
    assert.equal(clerkJwtKey(`\n  ${key.replace(/\n/g, "\r\n")}  `), key.trim());
  });

  test("rejects anything Clerk couldn't verify with", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    for (const value of [
      "pk_live_abc",
      "-----BEGIN PUBLIC KEY-----\nnot base64!\n-----END PUBLIC KEY-----",
      "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
      pem().replace("PUBLIC KEY-----\n", "RSA PUBLIC KEY-----\n"),
      pem(4096),
      ec,
    ]) {
      assert.equal(clerkJwtKey(value), null, value.slice(0, 60));
    }
    assert.throws(() => loadConfig({ ...base, CLERK_JWT_KEY: "pk_live_abc" }), /CLERK_JWT_KEY/);
  });
});

describe("rateLimitAddress", () => {
  test("IPv4 counts per address", () => {
    assert.equal(rateLimitAddress("203.0.113.7"), "203.0.113.7");
    assert.notEqual(rateLimitAddress("203.0.113.7"), rateLimitAddress("203.0.113.8"));
  });

  test("IPv6 counts per /64, whichever way the address is written", () => {
    const group = "2001:db8:abcd:12::/64";
    for (const ip of [
      "2001:db8:abcd:12::1",
      "2001:0db8:abcd:0012:0000:0000:0000:0001",
      "2001:DB8:ABCD:12:ffff:ffff:ffff:ffff",
      "2001:db8:abcd:12:1:2:3:4",
      "2001:db8:abcd:12::",
      "fe80::1%eth0".replace("fe80::1", "2001:db8:abcd:12::9"),
      "2001:db8:abcd:12:0:0:1.2.3.4",
    ]) {
      assert.equal(rateLimitAddress(ip), group, ip);
    }
    assert.equal(rateLimitAddress("2001:db8:abcd:13::1"), "2001:db8:abcd:13::/64");
    assert.equal(rateLimitAddress("2001:db8::1"), "2001:db8:0:0::/64");
    assert.equal(rateLimitAddress("::1"), "0:0:0:0::/64");
    assert.equal(rateLimitAddress("::"), "0:0:0:0::/64");
    assert.equal(rateLimitAddress("1::"), "1:0:0:0::/64");
  });

  test("IPv4-mapped IPv6 counts as the IPv4 address", () => {
    assert.equal(rateLimitAddress("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(rateLimitAddress("::FFFF:cb00:7107"), "203.0.113.7");
    assert.equal(rateLimitAddress("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7");
  });

  test("something that isn't an address is used as it is", () => {
    assert.equal(rateLimitAddress("unknown"), "unknown");
  });
});

describe("rateLimitKey", () => {
  const req = (extra: object = {}, headers: Record<string, string> = {}) => ({
    ip: "10.0.0.1",
    headers: { "cf-connecting-ip": "2001:db8:1:2::5", ...headers },
    ...extra,
  });

  test("is the verified user, never a claim from the token", () => {
    const forged = `x.${Buffer.from(JSON.stringify({ sub: "user_victim" })).toString("base64url")}.sig`;
    assert.equal(rateLimitKey(req({ user: { id: 7 } }, { authorization: `Bearer ${forged}` })), "user:7");
    assert.equal(rateLimitKey(req({ wsUser: { id: 8 } })), "user:8");
    assert.equal(rateLimitKey(req({ clerkId: "user_abc" })), "clerk:user_abc");
    assert.equal(rateLimitKey(req({}, { authorization: `Bearer ${forged}` })), "ip:2001:db8:1:2::/64");
    assert.equal(rateLimitKey({ ip: "10.0.0.1", headers: {} }), "ip:10.0.0.1");
  });
});
