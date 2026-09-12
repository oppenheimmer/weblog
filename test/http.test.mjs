// Tier 4 — request guards.
//
// Step 3's acceptance: anonymous requests reach nothing, expired and revoked
// sessions fail, and forged cross-origin requests fail. These drive the real
// route handlers through fake req/res objects, so what is tested is the code
// that will actually run, not a re-implementation of it.
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/server/r2.mjs";
import { hashPassword } from "../lib/server/passwords.mjs";
import { createSessionStore, csrfToken } from "../lib/server/sessions.mjs";
import { createRateLimiter } from "../lib/server/rate-limit.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { setContext, cookieName, checkOrigin, readJsonBody, allowedOrigins } from "../lib/server/http.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const ORIGIN = "http://localhost:3000";

/** Minimal stand-ins for Vercel's req/res. */
function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    end(payload) { this.body = payload; return this; },
  };
  res.json = () => JSON.parse(res.body ?? "null");
  return res;
}

function fakeReq({ method = "GET", headers = {}, body, url = "/api/x/", query } = {}) {
  return { method, url, query, headers: { origin: ORIGIN, ...headers }, body };
}

function harness() {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  const sessions = createSessionStore(store, { authVersion: 1 });
  const limiter = createRateLimiter(store, { secret: "test-secret" });
  setContext({ log: () => {}, store, sessions, limiter });
  return { store, sessions, limiter, drafts: createDraftStore(store) };
}

const authed = async (sessions) => {
  const { token, session } = await sessions.create();
  return { cookie: `${cookieName()}=${token}`, csrf: csrfToken(session), token };
};

// Routes are imported once; each test installs its own context.
const login = (await import("../api/auth/login.js")).default;
const logout = (await import("../api/auth/logout.js")).default;
const sessionRoute = (await import("../api/auth/session.js")).default;
const draftsIndex = (await import("../api/drafts/index.js")).default;
const draftById = (await import("../api/drafts/[id]/index.js")).default;

// ---------------------------------------------------------------- origin

test("allowed origins are matched exactly, not by suffix", () => {
  const origins = allowedOrigins();
  assert.ok(origins.length > 0);
  for (const evil of [
    "https://blog.souravmishra.net.attacker.com",
    "https://evil-blog.souravmishra.net",
    "http://localhost:3000.attacker.com",
  ]) {
    assert.equal(checkOrigin({ headers: { origin: evil } }).ok, false, `${evil} was allowed`);
  }
});

test("a mutating request with no Origin header is refused", () => {
  assert.equal(checkOrigin({ headers: {} }).ok, false);
});

// ---------------------------------------------------------------- anonymous

test("anonymous callers reach no private route", async () => {
  harness();
  for (const [handler, req] of [
    [draftsIndex, fakeReq({ method: "GET" })],
    [draftsIndex, fakeReq({ method: "POST", body: {} })],
    [draftById, fakeReq({ method: "GET", url: "/api/drafts/p_1/" })],
    [draftById, fakeReq({ method: "PUT", body: {} })],
    [logout, fakeReq({ method: "POST" })],
  ]) {
    const res = fakeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401, `${req.method} ${req.url} was not refused`);
    assert.equal(res.json().code, "unauthenticated");
  }
});

test("the session endpoint reports absence without leaking anything", async () => {
  harness();
  const res = fakeRes();
  await sessionRoute(fakeReq({ method: "GET" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { authenticated: false });
});

// ---------------------------------------------------------------- login

// Low cost: these exercise the route, not scrypt's strength.
const PASSPHRASE = "a-correct-passphrase";
const LOW_COST = { N: 1024, r: 8, p: 1, keyLength: 32 };
const { deviceCookieName } = await import("../lib/server/http.mjs");
const cookiesOf = (res) => [].concat(res.getHeader("set-cookie") ?? []);
const named = (res, name) => cookiesOf(res).find((cookie) => cookie.startsWith(`${name}=`));

const attemptLogin = async ({ password, address = "198.51.100.1", cookie } = {}) => {
  const res = fakeRes();
  await login(fakeReq({
    method: "POST",
    headers: { "x-vercel-forwarded-for": address, ...(cookie ? { cookie } : {}) },
    body: { password },
  }), res);
  return res;
};

test("a correct password mints a session cookie, a device cookie and a CSRF token", async () => {
  const { sessions } = harness();
  process.env.ADMIN_PASSWORD_HASH = await hashPassword(PASSPHRASE, LOW_COST);
  const res = await attemptLogin({ password: PASSPHRASE });

  assert.equal(res.statusCode, 200);
  const session = named(res, cookieName());
  const device = named(res, deviceCookieName());
  for (const cookie of [session, device]) {
    assert.ok(cookie, `missing a cookie in ${JSON.stringify(cookiesOf(res))}`);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.ok(!/Domain=/i.test(cookie), "a Domain attribute would widen the cookie to siblings");
  }
  assert.ok(res.json().csrfToken);

  // The session cookie's value is a real session.
  const token = session.split(";")[0].split("=").slice(1).join("=");
  assert.ok(await sessions.verify(token));
});

test("a browser that signed in before can still sign in while a spray has spent the shared budget", async () => {
  // Appendix C, F-02: anonymous failures used to refuse every login, the owner's included.
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  setContext({ log: () => {},
    store,
    sessions: createSessionStore(store, { authVersion: 1 }),
    limiter: createRateLimiter(store, { secret: "test-secret", maxGlobal: 3 }),
  });
  process.env.ADMIN_PASSWORD_HASH = await hashPassword(PASSPHRASE, LOW_COST);

  const first = await attemptLogin({ password: PASSPHRASE, address: "198.51.100.7" });
  assert.equal(first.statusCode, 200);
  const remembered = named(first, deviceCookieName()).split(";")[0];

  for (let i = 0; i < 6; i++) await attemptLogin({ password: "wrong-password-here", address: `203.0.113.${i}` });

  const stranger = await attemptLogin({ password: PASSPHRASE, address: "192.0.2.1" });
  assert.equal(stranger.statusCode, 429, "precondition: a browser that never signed in is bounded by the shared budget");
  const forged = await attemptLogin({
    password: PASSPHRASE, address: "192.0.2.1", cookie: `${deviceCookieName()}=v1.AAAAAAAAAAAAAAAAAAAAAA.forged`,
  });
  assert.equal(forged.statusCode, 429, "an unsigned device cookie was honoured");

  const owner = await attemptLogin({ password: PASSPHRASE, address: "192.0.2.1", cookie: remembered });
  assert.equal(owner.statusCode, 200, "failed attempts from strangers locked the owner out of a browser they use");
});

test("signing in repeatedly never locks the owner out, because a correct password costs nothing", async () => {
  harness();
  process.env.ADMIN_PASSWORD_HASH = await hashPassword(PASSPHRASE, LOW_COST);
  for (let i = 0; i < 8; i++) {
    assert.equal((await attemptLogin({ password: PASSPHRASE, address: "1.2.3.4" })).statusCode, 200, `sign-in ${i + 1}`);
  }
});

test("a wrong password is refused with the same message as a missing one", async () => {
  harness();
  const messages = new Set();
  for (const body of [{ password: "wrong-password-here" }, {}, { password: "" }]) {
    const res = fakeRes();
    await login(fakeReq({ method: "POST", body }), res);
    assert.equal(res.statusCode, 401);
    messages.add(res.json().message);
    assert.equal(res.getHeader("set-cookie"), undefined, "a failed login set a cookie");
  }
  assert.equal(messages.size, 1, "failure modes are distinguishable to an attacker");
});

test("login is rate limited before any password work happens", async () => {
  harness();
  const attempt = () => {
    const res = fakeRes();
    return login(fakeReq({
      method: "POST",
      headers: { "x-vercel-forwarded-for": "1.2.3.4" },
      body: { password: "wrong-password-here" },
    }), res).then(() => res);
  };
  for (let i = 0; i < 5; i++) assert.equal((await attempt()).statusCode, 401);
  const blocked = await attempt();
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().code, "rate_limited");
  assert.ok(blocked.getHeader("retry-after"));
});

test("login refuses a cross-origin request", async () => {
  harness();
  const res = fakeRes();
  await login(fakeReq({
    method: "POST",
    headers: { origin: "https://attacker.example" },
    body: { password: "anything-at-all" },
  }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "bad_origin");
});

// ---------------------------------------------------------------- CSRF

test("a mutating request without a CSRF token is refused even when signed in", async () => {
  const { sessions } = harness();
  const { cookie } = await authed(sessions);
  const res = fakeRes();
  await draftsIndex(fakeReq({ method: "POST", headers: { cookie }, body: { title: "x" } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "bad_csrf");
});

test("a CSRF token from another session is refused", async () => {
  const { sessions } = harness();
  const mine = await authed(sessions);
  const other = await authed(sessions);
  const res = fakeRes();
  await draftsIndex(fakeReq({
    method: "POST",
    headers: { cookie: mine.cookie, "x-csrf-token": other.csrf },
    body: { title: "x" },
  }), res);
  assert.equal(res.statusCode, 403);
});

test("reads do not require a CSRF token", async () => {
  const { sessions } = harness();
  const { cookie } = await authed(sessions);
  const res = fakeRes();
  await draftsIndex(fakeReq({ method: "GET", headers: { cookie } }), res);
  assert.equal(res.statusCode, 200);
});

// ---------------------------------------------------------------- sessions

test("a revoked session stops working immediately", async () => {
  const { sessions } = harness();
  const { cookie, csrf, token } = await authed(sessions);
  await sessions.revoke(token);
  const res = fakeRes();
  await draftsIndex(fakeReq({ method: "POST", headers: { cookie, "x-csrf-token": csrf }, body: {} }), res);
  assert.equal(res.statusCode, 401);
});

test("logout revokes the session and clears the cookie", async () => {
  const { sessions } = harness();
  const { cookie, csrf, token } = await authed(sessions);
  const res = fakeRes();
  await logout(fakeReq({ method: "POST", headers: { cookie, "x-csrf-token": csrf } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.getHeader("set-cookie"), /Max-Age=0/);
  assert.equal(await sessions.verify(token), null);
});

// ---------------------------------------------------------------- drafts

test("a signed-in owner can create, read and save a draft", async () => {
  const { sessions } = harness();
  const { cookie, csrf } = await authed(sessions);

  const created = fakeRes();
  await draftsIndex(fakeReq({
    method: "POST", headers: { cookie, "x-csrf-token": csrf },
    body: { title: "From the API", body: "Hello" },
  }), created);
  assert.equal(created.statusCode, 201);
  const { draft, etag } = created.json();

  const read = fakeRes();
  await draftById(fakeReq({ method: "GET", headers: { cookie }, query: { id: draft.postId } }), read);
  assert.equal(read.json().draft.title, "From the API");

  const saved = fakeRes();
  await draftById(fakeReq({
    method: "PUT", headers: { cookie, "x-csrf-token": csrf, "if-match": etag },
    query: { id: draft.postId }, body: { body: "Updated" },
  }), saved);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().draft.body, "Updated");
  assert.equal(saved.json().draft.version, 2);
});

test("saving without an ETag is refused rather than allowed to clobber", async () => {
  const { sessions } = harness();
  const { cookie, csrf } = await authed(sessions);
  const created = fakeRes();
  await draftsIndex(fakeReq({ method: "POST", headers: { cookie, "x-csrf-token": csrf }, body: {} }), created);

  const res = fakeRes();
  await draftById(fakeReq({
    method: "PUT", headers: { cookie, "x-csrf-token": csrf },
    query: { id: created.json().draft.postId }, body: { body: "x" },
  }), res);
  assert.equal(res.statusCode, 428);
  assert.equal(res.json().code, "etag_required");
});

test("a stale save returns 409 with the current draft, not just a rejection", async () => {
  const { sessions } = harness();
  const { cookie, csrf } = await authed(sessions);
  const created = fakeRes();
  await draftsIndex(fakeReq({
    method: "POST", headers: { cookie, "x-csrf-token": csrf }, body: { body: "original" },
  }), created);
  const { draft, etag } = created.json();

  const first = fakeRes();
  await draftById(fakeReq({
    method: "PUT", headers: { cookie, "x-csrf-token": csrf, "if-match": etag },
    query: { id: draft.postId }, body: { body: "from A" },
  }), first);
  assert.equal(first.statusCode, 200);

  const stale = fakeRes();
  await draftById(fakeReq({
    method: "PUT", headers: { cookie, "x-csrf-token": csrf, "if-match": etag },
    query: { id: draft.postId }, body: { body: "from B" },
  }), stale);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().current.body, "from A", "the conflict response must carry the real content");
  assert.ok(stale.json().etag, "no ETag to retry with");
});

test("HEAD is accepted wherever GET is, and never reaches a mutating branch", async () => {
  const { sessions, drafts } = harness();
  const { cookie } = await authed(sessions);

  const res = fakeRes();
  await draftsIndex(fakeReq({ method: "HEAD", headers: { cookie } }), res);
  assert.equal(res.statusCode, 200);

  // Handlers dispatch on req.method and fall through to their mutating branch
  // for anything unrecognised, so an un-normalized HEAD would create a draft.
  assert.deepEqual(await drafts.list(), [], "HEAD created a draft");
});

test("HEAD on a draft route does not fall through to save", async () => {
  const { sessions, drafts } = harness();
  const { cookie, csrf } = await authed(sessions);
  const created = fakeRes();
  await draftsIndex(fakeReq({
    method: "POST", headers: { cookie, "x-csrf-token": csrf }, body: { body: "original" },
  }), created);
  const { draft } = created.json();

  const res = fakeRes();
  await draftById(fakeReq({ method: "HEAD", headers: { cookie }, query: { id: draft.postId } }), res);
  assert.equal(res.statusCode, 200);

  const after = await drafts.get(draft.postId);
  assert.equal(after.draft.version, 1, "HEAD bumped the draft version");
  assert.equal(after.draft.body, "original");
});

test("an unknown method is refused with an Allow header", async () => {
  const { sessions } = harness();
  const { cookie } = await authed(sessions);
  const res = fakeRes();
  await draftsIndex(fakeReq({ method: "PATCH", headers: { cookie } }), res);
  assert.equal(res.statusCode, 405);
  assert.match(res.getHeader("allow"), /GET/);
  assert.match(res.getHeader("allow"), /HEAD/);
});

// ---------------------------------------------------------------- body limits

test("an oversized declared body is refused before it is read", async () => {
  await assert.rejects(
    () => readJsonBody({ headers: { "content-length": String(9_000_000) } }),
    (err) => err.status === 413
  );
});

test("every response forbids caching", async () => {
  const { sessions } = harness();
  const { cookie } = await authed(sessions);
  const res = fakeRes();
  await draftsIndex(fakeReq({ method: "GET", headers: { cookie } }), res);
  assert.equal(res.getHeader("cache-control"), "no-store");
  assert.equal(res.getHeader("x-content-type-options"), "nosniff");
});
