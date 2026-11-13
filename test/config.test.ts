import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isLanOrigin, loadConfig, originChecker } from "../src/config.js";

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
});
