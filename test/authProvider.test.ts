import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  SigningKeys,
  clerkAuthProvider,
  sessionTokenKid,
  signingKeyTimings,
  signingKeysFromJwks,
} from "../src/plugins/authProvider.js";

/*
 * Clerk is never called here: tokens are signed with keys made in the test,
 * and the JWKS download is replaced by a fake that counts its calls.
 */

function rsaKey() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

const pemOf = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();

function jwt(privateKey: KeyObject, header: object, payload: object): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${b64({ alg: "RS256", typ: "JWT", ...header })}.${b64(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function sessionPayload(sub: string, extra: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { sub, iat: now - 5, nbf: now - 5, exp: now + 60, azp: "https://gambitio.test", ...extra };
}

const allowAll = () => true;

describe("sessionTokenKid", () => {
  test("reads the kid of an RS256 token", () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "ins_1" })).toString("base64url");
    assert.equal(sessionTokenKid(`${header}.e30.sig`), "ins_1");
  });

  test("rejects malformed tokens and other algorithms before any key lookup", () => {
    const enc = (h: object) => Buffer.from(JSON.stringify(h)).toString("base64url");
    for (const token of [
      "",
      "abc",
      "a.b",
      "a.b.c.d",
      "!!!.e30.sig",
      `${enc({ alg: "HS256", kid: "k" })}.e30.sig`,
      `${enc({ alg: "none", kid: "k" })}.e30.sig`,
      `${enc({ alg: "RS256" })}.e30.sig`,
      `${enc({ alg: "RS256", kid: 5 })}.e30.sig`,
      `${enc({ alg: "RS256", kid: "x".repeat(200) })}.e30.sig`,
      `${"a".repeat(2000)}.e30.sig`,
    ]) {
      assert.equal(sessionTokenKid(token), null, token);
    }
  });
});

describe("SigningKeys", () => {
  let now: number;
  let fetches: number;
  let published: Map<string, string>;
  let failNext: boolean;
  let gate: Promise<void> | null;
  const original = { ...signingKeyTimings };

  const keys = () =>
    new SigningKeys(
      async () => {
        fetches++;
        if (gate) await gate;
        if (failNext) {
          failNext = false;
          throw new Error("Clerk is down");
        }
        return new Map(published);
      },
      { error: () => {} },
      () => now
    );

  beforeEach(() => {
    now = 1_000_000;
    fetches = 0;
    published = new Map([["kid_a", "PEM_A"]]);
    failNext = false;
    gate = null;
  });
  afterEach(() => Object.assign(signingKeyTimings, original));

  test("a known kid never fetches again until the keys are old", async () => {
    const k = keys();
    assert.equal(await k.keyFor("kid_a"), "PEM_A");
    now += 1000;
    for (let i = 0; i < 50; i++) assert.equal(await k.keyFor("kid_a"), "PEM_A");
    assert.equal(fetches, 1);
  });

  test("unknown kids fetch at most once per interval, however many arrive", async () => {
    const k = keys();
    await k.keyFor("kid_a");
    for (let i = 0; i < 100; i++) assert.equal(await k.keyFor(`forged_${i}`), null);
    assert.equal(fetches, 1, "the first fetch was the only one");
    now += signingKeyTimings.minFetchIntervalMs;
    for (let i = 0; i < 100; i++) assert.equal(await k.keyFor(`forged_more_${i}`), null);
    assert.equal(fetches, 2, "one more after the interval");
    // A genuine token still works throughout
    assert.equal(await k.keyFor("kid_a"), "PEM_A");
  });

  test("concurrent callers share the fetch in flight; none starts another", async () => {
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    const k = keys();
    const waiting = [k.keyFor("kid_a"), k.keyFor("kid_a"), k.keyFor("forged_1"), k.keyFor("forged_2")];
    open();
    assert.deepEqual(await Promise.all(waiting), ["PEM_A", "PEM_A", null, null]);
    assert.equal(fetches, 1);
  });

  test("after a key rotation the new kid is learned within one interval, even under a flood", async () => {
    const k = keys();
    await k.keyFor("kid_a");
    // Clerk rotates; a stranger keeps sending made-up kids
    published = new Map([["kid_b", "PEM_B"]]);
    now += 1000;
    assert.equal(await k.keyFor("forged_1"), null);
    assert.equal(await k.keyFor("kid_b"), null, "inside the window nobody fetches");
    now += signingKeyTimings.minFetchIntervalMs;
    // The stranger wins the next fetch...
    assert.equal(await k.keyFor("forged_2"), null);
    // ...but it brought every current key, the real new one included
    assert.equal(await k.keyFor("kid_b"), "PEM_B");
    assert.equal(fetches, 2);
  });

  test("old keys are refreshed in the background and dropped keys stop working", async () => {
    const k = keys();
    await k.keyFor("kid_a");
    published = new Map([["kid_b", "PEM_B"]]);
    now += signingKeyTimings.maxAgeMs;
    // Served from the old set while the refresh runs
    assert.equal(await k.keyFor("kid_a"), "PEM_A");
    await new Promise((r) => setImmediate(r));
    assert.equal(fetches, 2);
    assert.equal(await k.keyFor("kid_a"), null);
    assert.equal(await k.keyFor("kid_b"), "PEM_B");
  });

  test("a failed fetch keeps the old keys and is retried a little sooner", async () => {
    const k = keys();
    await k.keyFor("kid_a");
    now += signingKeyTimings.maxAgeMs;
    failNext = true;
    assert.equal(await k.keyFor("kid_a"), "PEM_A");
    await new Promise((r) => setImmediate(r));
    assert.equal(fetches, 2);
    assert.equal(await k.keyFor("kid_a"), "PEM_A", "still served after the failure");
    now += signingKeyTimings.retryAfterFailureMs;
    await k.keyFor("kid_a");
    await new Promise((r) => setImmediate(r));
    assert.equal(fetches, 3);
  });

  test("a key set with no usable key is a failure: the old keys stay", async () => {
    const k = keys();
    await k.keyFor("kid_a");
    published = new Map();
    now += signingKeyTimings.maxAgeMs;
    assert.equal(await k.keyFor("kid_a"), "PEM_A");
    await new Promise((r) => setImmediate(r));
    assert.equal(fetches, 2);
    assert.equal(await k.keyFor("kid_a"), "PEM_A", "not replaced by nothing");
    // Retried like any failure, not a whole interval later
    published = new Map([["kid_a", "PEM_A"], ["kid_b", "PEM_B"]]);
    now += signingKeyTimings.retryAfterFailureMs;
    assert.equal(await k.keyFor("kid_b"), "PEM_B");
    assert.equal(fetches, 3);
  });

  test("at a cold start a failed or empty fetch is retried after about two seconds, one at a time", async () => {
    const k = keys();
    failNext = true;
    assert.equal(await k.keyFor("kid_a"), null);
    assert.equal(fetches, 1);
    // A flood of forged tokens meanwhile causes no fetch
    for (let i = 0; i < 100; i++) assert.equal(await k.keyFor(`forged_${i}`), null);
    now += signingKeyTimings.coldRetryAfterFailureMs - 1;
    assert.equal(await k.keyFor("kid_a"), null);
    assert.equal(fetches, 1);
    // An empty answer counts as a failure too
    published = new Map();
    now += 1;
    assert.equal(await k.keyFor("kid_a"), null);
    assert.equal(fetches, 2);
    published = new Map([["kid_a", "PEM_A"]]);
    now += signingKeyTimings.coldRetryAfterFailureMs;
    assert.equal(await k.keyFor("kid_a"), "PEM_A");
    assert.equal(fetches, 3);
    // With keys known, unknown kids are back to one fetch per interval
    now += signingKeyTimings.coldRetryAfterFailureMs;
    assert.equal(await k.keyFor("forged_x"), null);
    assert.equal(fetches, 3);
  });

  test("a fetch that never answers times out instead of blocking sign-ins", async () => {
    signingKeyTimings.fetchTimeoutMs = 20;
    gate = new Promise(() => {});
    const k = keys();
    // The timeout timer is unref'd (it mustn't keep a server alive): hold the test open
    const keepAlive = setTimeout(() => {}, 1_000);
    assert.equal(await k.keyFor("kid_a"), null);
    clearTimeout(keepAlive);
    assert.equal(fetches, 1);
  });
});

describe("clerkAuthProvider", () => {
  test("with CLERK_JWT_KEY, verifies locally and checks the authorized party", async () => {
    const { privateKey, publicKey } = rsaKey();
    const auth = clerkAuthProvider({
      secretKey: "sk_test_unused",
      jwtKey: pemOf(publicKey),
      isAuthorizedParty: (origin) => origin === "https://gambitio.test",
      fetchKeys: async () => {
        throw new Error("must not fetch when a JWT key is configured");
      },
    });
    assert.equal(await auth.verifyToken(jwt(privateKey, { kid: "any" }, sessionPayload("user_1"))), "user_1");
    // No authorized party at all is rejected too, as Clerk's authorizedParties does
    assert.equal(await auth.verifyToken(jwt(privateKey, {}, sessionPayload("user_1", { azp: undefined }))), null);
    assert.equal(
      await auth.verifyToken(jwt(privateKey, {}, sessionPayload("user_1", { azp: "https://evil.test" }))),
      null
    );
    // Expired, or signed by someone else
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await auth.verifyToken(jwt(privateKey, {}, sessionPayload("u", { exp: now - 120 }))), null);
    assert.equal(await auth.verifyToken(jwt(rsaKey().privateKey, {}, sessionPayload("u"))), null);
    assert.equal(await auth.verifyToken("not.a.token"), null);
  });

  test("without it, fetched keys verify tokens and forged kids don't cause fetches", async () => {
    const { privateKey, publicKey } = rsaKey();
    let fetches = 0;
    const auth = clerkAuthProvider({
      secretKey: "sk_test_unused",
      isAuthorizedParty: allowAll,
      fetchKeys: async () => {
        fetches++;
        return new Map([["ins_key", pemOf(publicKey)]]);
      },
    });
    const good = jwt(privateKey, { kid: "ins_key" }, sessionPayload("user_2"));
    assert.equal(await auth.verifyToken(good), "user_2");
    // A token naming the right kid but signed with another key
    assert.equal(await auth.verifyToken(jwt(rsaKey().privateKey, { kid: "ins_key" }, sessionPayload("x"))), null);
    // A flood of random kids (and malformed tokens) right after
    for (let i = 0; i < 200; i++) {
      assert.equal(await auth.verifyToken(jwt(privateKey, { kid: `random_${i}` }, sessionPayload("x"))), null);
      assert.equal(await auth.verifyToken(`garbage${i}`), null);
    }
    assert.equal(fetches, 1);
    assert.equal(await auth.verifyToken(good), "user_2");
  });
});

describe("signingKeysFromJwks", () => {
  test("turns Clerk's RSA keys into PEMs that verify, and skips the rest", async () => {
    const { privateKey, publicKey } = rsaKey();
    const jwk = publicKey.export({ format: "jwk" });
    const big = generateKeyPairSync("rsa", { modulusLength: 3072 }).publicKey.export({ format: "jwk" });
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
    const pems = signingKeysFromJwks([
      { ...jwk, kid: "good", alg: "RS256", use: "sig" } as never,
      { ...big, kid: "too_big", alg: "RS256" } as never,
      { ...ec, kid: "ec" } as never,
      { ...jwk, kid: "enc", use: "enc" } as never,
      { kid: "broken", kty: "RSA", n: "!!", e: "AQAB" },
    ]);
    assert.deepEqual([...pems.keys()], ["good"]);
    const auth = clerkAuthProvider({
      secretKey: "sk_test_unused",
      isAuthorizedParty: allowAll,
      fetchKeys: async () => pems,
    });
    assert.equal(await auth.verifyToken(jwt(privateKey, { kid: "good" }, sessionPayload("user_3"))), "user_3");
  });
});
