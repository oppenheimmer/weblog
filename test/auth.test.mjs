// Tier 4 — authentication primitives.
//
// Step 3's acceptance is that anonymous requests reach nothing, expired and
// revoked sessions fail, brute force is throttled across instances, and forged
// cross-origin requests fail. These cover the first three; origin checks land
// with the request guard.
import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, parseHash, DEFAULT_PARAMS } from "../lib/server/passwords.mjs";
import {
  createSessionStore, csrfToken, verifyCsrf, hashToken, newToken,
  IDLE_TIMEOUT_MS, ABSOLUTE_LIFETIME_MS,
} from "../lib/server/sessions.mjs";
import { createRateLimiter, hashClient, clientAddress } from "../lib/server/rate-limit.mjs";
import { createStore } from "../lib/server/r2.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const newBackend = () => createStore({ config: FAKE_CONFIG, client: createFakeS3() });

// Keep the suite fast: real parameters are exercised once, below.
const FAST = { N: 1024, r: 8, p: 1, keyLength: 32 };

// ---------------------------------------------------------------- passwords

test("a correct password verifies and a wrong one does not", async () => {
  const stored = await hashPassword("correct horse battery staple", FAST);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("the stored hash contains no plaintext and describes its own parameters", async () => {
  const password = "a-very-secret-passphrase";
  const stored = await hashPassword(password, FAST);
  assert.ok(!stored.includes(password), "the password leaked into its own hash");
  const parsed = parseHash(stored);
  assert.equal(parsed.N, FAST.N);
  assert.equal(parsed.r, FAST.r);
  assert.equal(parsed.salt.length, 16);
});

test("each hash uses a fresh salt, so identical passwords differ", async () => {
  const [a, b] = await Promise.all([
    hashPassword("same-password-here", FAST),
    hashPassword("same-password-here", FAST),
  ]);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same-password-here", a), true);
  assert.equal(await verifyPassword("same-password-here", b), true);
});

test("trivially short passwords are refused at hash time", async () => {
  await assert.rejects(() => hashPassword("short", FAST), /at least 12/);
});

test("a malformed or absent stored hash fails closed rather than throwing", async () => {
  for (const bad of [undefined, null, "", "not-a-hash", "scrypt$1$2$3", "bcrypt$a$b$c$d$e"]) {
    assert.equal(await verifyPassword("anything", bad), false, `${bad} did not fail closed`);
  }
});

test("verification works at the real default parameters", async () => {
  const stored = await hashPassword("a-real-length-passphrase", DEFAULT_PARAMS);
  assert.equal(await verifyPassword("a-real-length-passphrase", stored), true);
  assert.equal(await verifyPassword("a-real-length-passphras", stored), false);
});

// ---------------------------------------------------------------- sessions

test("a fresh session verifies; a random token does not", async () => {
  const sessions = createSessionStore(newBackend());
  const { token } = await sessions.create();
  assert.ok(await sessions.verify(token));
  assert.equal(await sessions.verify(newToken()), null);
  assert.equal(await sessions.verify(""), null);
  assert.equal(await sessions.verify(undefined), null);
});

test("only the token hash is stored, never the token", async () => {
  const backend = newBackend();
  const sessions = createSessionStore(backend);
  const { token } = await sessions.create();
  const stored = await backend.getJson(`sessions/${hashToken(token)}.json`);
  assert.ok(stored, "session record not found under its token hash");
  assert.ok(!JSON.stringify(stored.data).includes(token), "the plaintext token was stored");
});

test("revoking a session takes effect immediately", async () => {
  const sessions = createSessionStore(newBackend());
  const { token } = await sessions.create();
  await sessions.revoke(token);
  assert.equal(await sessions.verify(token), null);
});

test("an idle session expires, but an active one is refreshed indefinitely", async () => {
  let clock = 1_000_000;
  const sessions = createSessionStore(newBackend(), { now: () => clock });
  const { token } = await sessions.create();

  // Active use well past the idle window keeps it alive.
  for (let i = 0; i < 5; i++) {
    clock += IDLE_TIMEOUT_MS - 60_000;
    assert.ok(await sessions.verify(token), `session died while still in use (round ${i})`);
  }

  // Then go quiet for longer than the idle window.
  clock += IDLE_TIMEOUT_MS + 1;
  assert.equal(await sessions.verify(token), null, "an idle session outlived its timeout");
});

test("the absolute ceiling holds even for a continuously active session", async () => {
  let clock = 1_000_000;
  const sessions = createSessionStore(newBackend(), { now: () => clock });
  const { token } = await sessions.create();

  const step = 60 * 60 * 1000; // touch hourly, never idle
  for (let elapsed = 0; elapsed < ABSOLUTE_LIFETIME_MS - step; elapsed += step) {
    clock += step;
    assert.ok(await sessions.verify(token), "session died before its ceiling");
  }
  clock += step * 2;
  assert.equal(await sessions.verify(token), null, "session outlived its absolute ceiling");
});

test("rotating AUTH_VERSION revokes every existing session at once", async () => {
  const backend = newBackend();
  const { token } = await createSessionStore(backend, { authVersion: 1 }).create();
  assert.ok(await createSessionStore(backend, { authVersion: 1 }).verify(token));
  assert.equal(await createSessionStore(backend, { authVersion: 2 }).verify(token), null);
});

test("an expired record is rejected on read, not merely swept later", async () => {
  let clock = 1_000_000;
  const backend = newBackend();
  const sessions = createSessionStore(backend, { now: () => clock });
  const { token } = await sessions.create();

  clock += ABSOLUTE_LIFETIME_MS + 1;
  assert.equal(await sessions.verify(token), null);
  // The record is still physically present — rejection did not depend on cleanup.
  assert.ok(await backend.getJson(`sessions/${hashToken(token)}.json`));
});

test("sweeping removes dead sessions and keeps live ones", async () => {
  let clock = 1_000_000;
  const backend = newBackend();
  const sessions = createSessionStore(backend, { now: () => clock });
  const dead = await sessions.create();
  clock += ABSOLUTE_LIFETIME_MS + 1;
  const alive = await sessions.create();

  assert.equal(await sessions.sweep(), 1);
  assert.equal(await sessions.verify(dead.token), null);
  assert.ok(await sessions.verify(alive.token));
});

// ---------------------------------------------------------------- CSRF

test("a CSRF token validates for its own session only", async () => {
  const sessions = createSessionStore(newBackend());
  const a = await sessions.create();
  const b = await sessions.create();

  const tokenA = csrfToken(a.session);
  assert.equal(verifyCsrf(a.session, tokenA), true);
  assert.equal(verifyCsrf(b.session, tokenA), false, "a CSRF token was replayable across sessions");
  assert.equal(verifyCsrf(a.session, "wrong"), false);
  assert.equal(verifyCsrf(a.session, ""), false);
});

// ---------------------------------------------------------------- rate limit

const limiterOn = (backend, now, options = {}) =>
  createRateLimiter(backend, { secret: "test-secret", now, ...options });

/**
 * A backend whose first `size` reads of rate-limit counters wait for one
 * another, so every attempt in a burst reads the same count before any of them
 * writes. That is the interleaving that defeated check-then-record; a fake store
 * left to itself runs requests one after another and the race never happens.
 */
function barrieredBackend(size) {
  const fake = createFakeS3();
  const waiting = [];
  let remaining = size;
  const client = {
    objects: fake.objects,
    async send(command) {
      if (remaining > 0 && command.constructor.name === "GetObjectCommand" &&
          String(command.input.Key).includes("rate-limits/")) {
        remaining--;
        await new Promise((resolve) => {
          waiting.push(resolve);
          if (waiting.length === size) waiting.forEach((release) => release());
        });
      }
      return fake.send(command);
    },
  };
  return createStore({ config: FAKE_CONFIG, client });
}

test("five attempts from one address are admitted, and the sixth is refused", async () => {
  const limiter = limiterOn(newBackend(), () => 1_000_000);
  for (let i = 0; i < 5; i++) {
    assert.equal((await limiter.admit({ client: "1.2.3.4" })).allowed, true, `attempt ${i + 1} was refused too early`);
  }
  const sixth = await limiter.admit({ client: "1.2.3.4" });
  assert.equal(sixth.allowed, false);
  assert.ok(sixth.retryAfterMs > 0, "a refusal did not say how long to wait");
});

test("a synchronized burst is admitted no further than the limit, because admission is the count", async () => {
  // Appendix C, F-01: reading the count first let all twelve of these through.
  const limiter = limiterOn(barrieredBackend(12), () => 1_000_000);
  const results = await Promise.all(Array.from({ length: 12 }, () => limiter.admit({ client: "1.2.3.4" })));
  const admitted = results.filter((r) => r.allowed).length;
  assert.ok(admitted >= 1, "nothing in the burst was admitted at all");
  assert.ok(admitted <= 5, `${admitted} of 12 simultaneous attempts were admitted past a limit of 5`);
});

test("the limit is per address: one address's failures do not refuse another", async () => {
  const limiter = limiterOn(newBackend(), () => 1_000_000);
  for (let i = 0; i < 6; i++) await limiter.admit({ client: "1.2.3.4" });
  assert.equal((await limiter.admit({ client: "5.6.7.8" })).allowed, true, "an unrelated client was refused");
});

test("an address already over its limit spends nothing from the shared budget", async () => {
  const limiter = limiterOn(newBackend(), () => 1_000_000, { maxGlobal: 6 });
  for (let i = 0; i < 20; i++) await limiter.admit({ client: "1.2.3.4" }); // five admitted, fifteen refused
  assert.equal((await limiter.admit({ client: "9.9.9.9" })).allowed, true,
    "one address's refused attempts drained the budget everyone else shares");
});

test("a shared budget bounds the password work anonymous traffic can cause", async () => {
  const limiter = limiterOn(newBackend(), () => 1_000_000, { maxGlobal: 12 });
  for (let i = 0; i < 12; i++) {
    assert.equal((await limiter.admit({ client: `10.0.0.${i}` })).allowed, true);
  }
  assert.equal((await limiter.admit({ client: "10.0.0.200" })).allowed, false,
    "a spray across many addresses was not bounded");
});

test("a browser that has signed in before cannot be locked out by anyone else's failures", async () => {
  // Appendix C, F-02: one shared counter used to refuse every client, the owner included.
  const limiter = limiterOn(newBackend(), () => 1_000_000, { maxGlobal: 3 });
  const { id } = limiter.deviceCookie();
  for (let i = 0; i < 10; i++) await limiter.admit({ client: `10.0.0.${i}` });
  assert.equal((await limiter.admit({ client: "10.0.0.99" })).allowed, false, "precondition: the shared budget is spent");
  assert.equal((await limiter.admit({ client: "10.0.0.1", device: id })).allowed, true,
    "a spray locked the owner out of a browser they already use");
});

test("a known device is still limited on its own", async () => {
  const limiter = limiterOn(newBackend(), () => 1_000_000);
  const { id } = limiter.deviceCookie();
  for (let i = 0; i < 5; i++) {
    assert.equal((await limiter.admit({ client: "1.2.3.4", device: id })).allowed, true);
  }
  assert.equal((await limiter.admit({ client: "1.2.3.4", device: id })).allowed, false,
    "a device cookie bought unlimited guesses");
});

test("only a device cookie this server signed names a device", () => {
  const limiter = limiterOn(newBackend(), () => 1_000_000);
  const { id, value } = limiter.deviceCookie();
  assert.equal(limiter.identifyDevice(value), id);

  const [version, deviceId, mac] = value.split(".");
  const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
  const elsewhere = createRateLimiter(newBackend(), { secret: "a-different-secret" });
  for (const forged of [
    elsewhere.deviceCookie(id).value,
    `${version}.${deviceId}.${flipped}`,
    `${version}.${limiter.deviceCookie().id}.${mac}`,
    `v2.${deviceId}.${mac}`,
    `${value}.extra`,
    `v1.${deviceId}.`,
    "v1..", "garbage", "", null, undefined,
  ]) {
    assert.equal(limiter.identifyDevice(forged), null, `accepted a cookie this server did not sign: ${forged}`);
  }
});

test("a correct password gives its attempt back, so signing in never locks the owner out", async () => {
  const limiter = limiterOn(newBackend(), () => 1_000_000);
  for (let i = 0; i < 20; i++) {
    const admission = await limiter.admit({ client: "1.2.3.4" });
    assert.equal(admission.allowed, true, `sign-in ${i + 1} was refused`);
    await limiter.release(admission);
  }
});

test("a refund gives back one attempt, not the failures that came before it", async () => {
  // An attacker sharing the owner's address (a NAT, a café) must not have their
  // failed guesses forgiven because the owner then signed in from there.
  const limiter = limiterOn(newBackend(), () => 1_000_000);
  for (let i = 0; i < 4; i++) await limiter.admit({ client: "1.2.3.4" }); // four failures, kept
  await limiter.release(await limiter.admit({ client: "1.2.3.4" }));      // the owner signs in
  assert.equal((await limiter.admit({ client: "1.2.3.4" })).allowed, true, "the address had one attempt left");
  assert.equal((await limiter.admit({ client: "1.2.3.4" })).allowed, false,
    "signing in wiped the address's earlier failures instead of returning one attempt");
});

test("the window rolls, so a refusal expires on its own", async () => {
  let clock = 1_000_000;
  const limiter = limiterOn(newBackend(), () => clock);
  for (let i = 0; i < 6; i++) await limiter.admit({ client: "1.2.3.4" });
  assert.equal((await limiter.admit({ client: "1.2.3.4" })).allowed, false);

  clock += 15 * 60 * 1000 + 1;
  assert.equal((await limiter.admit({ client: "1.2.3.4" })).allowed, true, "the refusal never expired");
});

test("client identifiers are hashed, so no plaintext address is stored", async () => {
  const backend = newBackend();
  const limiter = limiterOn(backend, () => 1_000_000);
  await limiter.admit({ client: "203.0.113.9" });
  const keys = await backend.listAll("rate-limits/");
  assert.ok(keys.length > 0);
  for (const { key } of keys) {
    assert.ok(!key.includes("203.0.113.9"), `a plaintext address became a key: ${key}`);
  }
  assert.notEqual(hashClient("203.0.113.9", "s1"), hashClient("203.0.113.9", "s2"));
});

test("the client address is read only from platform metadata, never from the browser", () => {
  assert.equal(clientAddress({ "x-vercel-forwarded-for": "9.9.9.9" }), "9.9.9.9");
  assert.equal(
    clientAddress({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }),
    "2.2.2.2",
    "a browser-settable header was trusted for rate-limit identity"
  );
  assert.equal(clientAddress({ "x-forwarded-for": "1.1.1.1" }), null);
});

test("an attempt that cannot be counted is refused, not waved through", async () => {
  const broken = {
    getJson: async () => { throw new Error("R2 unreachable"); },
    mutateJson: async () => { throw new Error("R2 unreachable"); },
    listAll: async () => [],
  };
  const limiter = createRateLimiter(broken, { secret: "s" });
  for (const device of [null, limiter.deviceCookie().id]) {
    const result = await limiter.admit({ client: "1.2.3.4", device });
    assert.equal(result.allowed, false, "an unwritable rate-limit store let the attempt through");
    assert.equal(result.failedClosed, true);
  }
});

test("sweeping drops elapsed windows and keeps the current one", async () => {
  let clock = 1_000_000;
  const backend = newBackend();
  const limiter = limiterOn(backend, () => clock);
  await limiter.admit({ client: "1.2.3.4" });
  clock += 15 * 60 * 1000 * 3;
  await limiter.admit({ client: "1.2.3.4" });

  assert.equal(await limiter.sweep(), 2); // the old window's client and shared records
  const next = await limiter.admit({ client: "1.2.3.4" });
  assert.equal(next.charges[0].count, 2, "the current window was swept away");
});
