// Tier 4 — structured request logs (CLAUDE.md Step 9).
//
// Two promises. Every request leaves one line a person can search by request,
// post, job or revision id. And no line carries a password, a cookie, a CSRF
// token, a signed URL or a draft's text — asserted by sending all of them
// through real routes and reading every line that came out, not by trusting
// the allowlist to be right.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createSessionStore, csrfToken } from "../lib/server/sessions.mjs";
import { createRateLimiter } from "../lib/server/rate-limit.mjs";
import { hashPassword } from "../lib/server/passwords.mjs";
import { setContext, cookieName, route, sendJson } from "../lib/server/http.mjs";
import { safeFields } from "../lib/server/log.mjs";
import publishRoute from "../api/publish.js";
import uploadsRoute from "../api/uploads/index.js";
import draftsRoute from "../api/drafts/index.js";
import draftById from "../api/drafts/[id]/index.js";
import loginRoute from "../api/auth/login.js";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const ORIGIN = "https://blog.example";
const PASSWORD = "correct horse battery staple";
const CANARY = "UNPUBLISHED-DRAFT-TEXT-CANARY";
const PNG = fs.readFileSync(new URL("./fixtures/media/sample-7x11.png", import.meta.url));

async function harness() {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const sessions = createSessionStore(store, { authVersion: 1 });
  const lines = [];
  setContext({
    store, sessions,
    limiter: createRateLimiter(store, { secret: "logging" }),
    fireDeployHook: async () => ({ job: "d" }),
    housekeep: async () => ({ ok: true, swept: { deleted: 0, bytesFreed: 0 } }),
    signPut: async (key) => `https://weblog.acct.r2.cloudflarestorage.com/${key}?X-Amz-Signature=deadbeefcafe`,
    log: (line) => lines.push(line),
  });
  process.env.SITE_URL = ORIGIN;
  process.env.ADMIN_PASSWORD_HASH = await hashPassword(PASSWORD, { N: 1024, r: 8, p: 1, keyLength: 32 });
  const { token, session } = await sessions.create();
  const secrets = { token, csrf: csrfToken(session) };
  return { store, sessions, lines, secrets, parsed: () => lines.map((line) => JSON.parse(line)) };
}

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    end(payload) { this.body = payload; return this; },
  };
}

async function call(h, handler, { method = "POST", url, body, signedIn = true, query } = {}) {
  const res = fakeRes();
  const headers = { origin: ORIGIN, "content-type": "application/json" };
  if (signedIn) {
    headers.cookie = `${cookieName()}=${h.secrets.token}`;
    headers["x-csrf-token"] = h.secrets.csrf;
  }
  await handler({ method, url, headers, body, query }, res);
  return { status: res.statusCode, json: JSON.parse(res.body ?? "null"), res };
}

test("every request leaves one line naming its request, route, status and duration", async () => {
  const h = await harness();
  const { json } = await call(h, draftsRoute, { method: "GET", url: "/api/drafts/?unused=1" });
  const [line] = h.parsed();
  assert.equal(h.lines.length, 1);
  assert.equal(line.event, "request");
  assert.equal(line.method, "GET");
  assert.equal(line.path, "/api/drafts/", "the query string reached the log");
  assert.equal(line.status, 200);
  assert.equal(typeof line.ms, "number");
  assert.match(line.requestId, /^[0-9a-f]{16}$/);
  assert.ok(json.drafts, "the request itself did not complete");
});

test("a publish names what it acted on: the action, the post, the job and the revision", async () => {
  const h = await harness();
  const { draft } = await createDraftStore(h.store).create({ title: "Logged", date: "2026-07-01", body: "Text.", slug: "logged" });
  const { json } = await call(h, publishRoute, { url: "/api/publish/", body: { postId: draft.postId } });
  const line = h.parsed().at(-1);
  assert.equal(json.job.state, "building");
  assert.deepEqual(
    [line.action, line.postId, line.jobId, line.revisionId],
    ["publish", draft.postId, json.job.jobId, draft.revisionId]
  );
});

test("a refusal is logged by its code, never by its message", async () => {
  const h = await harness();
  const { json } = await call(h, publishRoute, { url: "/api/publish/", body: { action: "unpublish", postId: "../escape" } });
  const line = h.parsed().at(-1);
  assert.deepEqual([line.status, line.code, json.code], [400, "invalid_post", "invalid_post"]);
  assert.ok(!JSON.stringify(line).includes(json.message), "a refusal's message reached the log");
});

test("a refusal thrown through the route is logged by its code too, not by what it quotes", async () => {
  // Draft validation throws, and its message repeats the author's input.
  const h = await harness();
  const created = await call(h, draftsRoute, { url: "/api/drafts/", body: { title: "Dated" } });
  const postId = created.json.draft.postId;
  const { status, json } = await call(h, draftById, {
    method: "PUT", url: `/api/drafts/${postId}/`, query: { id: postId },
    body: { date: "2026-02-30", etag: created.json.etag },
  });
  const line = h.parsed().at(-1);
  assert.equal(status, 400);
  assert.match(json.message, /2026-02-30/, "the refusal no longer quotes its input, so nothing was tested");
  assert.ok(!h.lines.join("\n").includes("2026-02-30"), "a thrown refusal's message reached the log");
  assert.equal(line.level, "warn");
});

test("no line carries a password, cookie, CSRF token, signed URL or draft text", async () => {
  const h = await harness();
  await call(h, loginRoute, { url: "/api/auth/login/", body: { password: PASSWORD }, signedIn: false });
  await call(h, loginRoute, { url: "/api/auth/login/", body: { password: `${PASSWORD}-wrong` }, signedIn: false });
  const created = await call(h, draftsRoute, { url: "/api/drafts/", body: { title: "Private", body: CANARY } });
  const postId = created.json.draft.postId;
  await call(h, draftById, {
    method: "PUT", url: `/api/drafts/${postId}/`, query: { id: postId },
    body: { title: "Private", body: `${CANARY} edited`, etag: created.json.etag },
  });
  const signed = await call(h, uploadsRoute, {
    url: "/api/uploads/", body: { action: "sign", postId, name: "a.png", size: PNG.length, type: "image/png" },
  });
  await call(h, publishRoute, { url: "/api/publish/", body: { action: "check", postId, title: "Private", body: CANARY, date: "2026-07-01" } });

  assert.ok(signed.json.url.includes("X-Amz-Signature"), "the upload was not signed, so nothing was tested");
  const all = h.lines.join("\n");
  for (const [what, secret] of [
    ["the password", PASSWORD], ["the session token", h.secrets.token], ["the CSRF token", h.secrets.csrf],
    ["the signed URL", "X-Amz-Signature"], ["the draft's text", CANARY], ["a cookie", cookieName()],
  ]) {
    assert.ok(!all.includes(secret), `${what} reached the log`);
  }
  // The harness made one session; a real sign-in makes a second.
  assert.equal((await h.store.listAll("sessions/")).length, 2, "sign-in did not succeed, so it was not tested");
  assert.equal(h.lines.length, 6, "a request was not logged");
  assert.deepEqual(h.parsed().slice(0, 2).map((line) => line.outcome), ["signed_in", "refused"]);
});

test("fields that are not known ids or names are dropped, whoever supplies them", () => {
  assert.deepEqual(safeFields({
    postId: "p_00000000000000aa", action: "publish",
    note: "free text", password: "hunter2", jobId: "../../etc", revisionId: "r_000001 <script>",
    code: "slug_taken", outcome: 42,
  }), { postId: "p_00000000000000aa", action: "publish", code: "slug_taken" });
});

test("a server failure logs its error with a stack, and still answers without one", async () => {
  const h = await harness();
  const failing = route(async () => { throw new Error("the bucket fell over"); }, { methods: ["GET"], auth: false });
  const { status, json } = await call(h, failing, { method: "GET", url: "/api/broken/", signedIn: false });
  const line = h.parsed().at(-1);
  assert.equal(status, 500);
  assert.ok(!JSON.stringify(json).includes("the bucket fell over"), "the response leaked the failure");
  assert.equal(line.level, "error");
  assert.equal(line.error.message, "the bucket fell over");
  assert.match(line.error.stack, /logging\.test\.mjs/);
});

test("a log that cannot be written never fails the request", async () => {
  const h = await harness();
  setContext({ store: h.store, sessions: h.sessions, log: () => { throw new Error("stdout closed"); } });
  const ok = route(async ({ res }) => sendJson(res, 200, { fine: true }), { methods: ["GET"], auth: false });
  const { status, json } = await call(h, ok, { method: "GET", url: "/api/ok/", signedIn: false });
  assert.deepEqual([status, json], [200, { fine: true }]);
});
