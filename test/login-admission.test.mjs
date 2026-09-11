// Tier 4 — login admission under concurrency (CLAUDE.md Appendix C, F-01).
//
// What matters is how many times the password was verified, not what the
// responses say. When the limit was read first and counted after scrypt, a
// synchronized burst still got plausible statuses back while every attempt in
// it had already run a 128 MiB verification. So this counts scrypt itself.
import { scryptCalls } from "./helpers/count-scrypt.mjs"; // first: passwords.mjs captures scrypt on load
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/server/r2.mjs";
import { hashPassword } from "../lib/server/passwords.mjs";
import { createSessionStore } from "../lib/server/sessions.mjs";
import { createRateLimiter, MAX_PER_CLIENT } from "../lib/server/rate-limit.mjs";
import { setContext } from "../lib/server/http.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const login = (await import("../api/auth/login.js")).default;

function fakeRes() {
  return {
    statusCode: 0, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    end() { return this; },
  };
}

/**
 * A fake S3 client that holds the first `size` reads of rate-limit counters
 * until all of them have arrived, so every attempt in a burst reads the same
 * count before any of them writes. Left alone, a fake store runs requests one
 * after another and the race never happens.
 */
function burstClient(size) {
  const fake = createFakeS3();
  const waiting = [];
  let remaining = size;
  return {
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
}

test("a synchronized burst of wrong passwords runs the password check no more than the limit", async () => {
  const store = createStore({ config: FAKE_CONFIG, client: burstClient(12) });
  setContext({
    store,
    sessions: createSessionStore(store, { authVersion: 1 }),
    limiter: createRateLimiter(store, { secret: "test-secret" }),
  });

  const before = scryptCalls.count;
  process.env.ADMIN_PASSWORD_HASH =
    await hashPassword("a-correct-passphrase", { N: 1024, r: 8, p: 1, keyLength: 32 });
  assert.equal(scryptCalls.count, before + 1, "the counter does not see password work, so this test would prove nothing");

  scryptCalls.count = 0;
  const statuses = await Promise.all(Array.from({ length: 12 }, async () => {
    const res = fakeRes();
    await login({
      method: "POST", url: "/api/auth/login/",
      headers: { origin: "http://localhost:3000", "x-vercel-forwarded-for": "1.2.3.4" },
      body: { password: "wrong-password-here" },
    }, res);
    return res.statusCode;
  }));

  const refused = statuses.filter((status) => status === 429).length;
  assert.ok(scryptCalls.count <= MAX_PER_CLIENT,
    `${scryptCalls.count} of 12 simultaneous attempts ran scrypt against a limit of ${MAX_PER_CLIENT}`);
  assert.equal(scryptCalls.count, 12 - refused, `each attempt not refused should be exactly one verification: ${statuses}`);
  assert.ok(statuses.every((status) => status === 401 || status === 429), `unexpected statuses: ${statuses}`);
});
