// Tier 3 and Tier 4 — bundle upload: agree, transfer, verify, promote (§3.6).
//
// The property everything else rests on is that a *verified* bundle is one
// whose bytes were rehashed on the server. The revision id is derived from the
// declared hashes, so a file that disagrees with its declaration would be
// published under an id describing different content — which is why the
// mismatch cases here matter more than the happy path.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createInteractives, BundleError } from "../lib/server/interactives.mjs";
import { keys, classifyKey } from "../lib/server/keys.mjs";
import { computeRevisionId, validateManifest, LIMITS } from "../lib/interactives.mjs";
import { collectGarbage } from "../lib/server/inventory.mjs";
import { createSessionStore, csrfToken } from "../lib/server/sessions.mjs";
import { createRateLimiter } from "../lib/server/rate-limit.mjs";
import { setContext, cookieName } from "../lib/server/http.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const FILES = {
  "index.html": "<!doctype html><title>lab</title><script type=module src=./demo.mjs></script>",
  "fallback.html": "<!doctype html><p>A still picture of the lab.</p>",
  "demo.mjs": "export const ready = true;\n",
  "data.json": '{"points":[1,2,3]}',
};

/** A manifest describing FILES, as a push would compute it locally. */
function manifest(over = {}, files = FILES) {
  return {
    kind: "demo",
    name: "orbit",
    entry: "index.html",
    fallback: "fallback.html",
    files: Object.entries(files).map(([name, body]) => ({
      name,
      bytes: Buffer.byteLength(body),
      sha256: sha256(Buffer.from(body)),
    })),
    ...over,
  };
}

async function harness() {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  const signed = [];
  const interactives = createInteractives(store, {
    signPut: async (key, options) => {
      signed.push({ key, ...options });
      return `https://signed.example/${encodeURIComponent(key)}`;
    },
  });
  const { draft } = await createDraftStore(store).create({ title: "A post", body: "text" });
  return { store, client, interactives, signed, postId: draft.postId };
}

/** Do what the browser or the staging push would do with the signed URLs. */
async function transfer(store, postId, uploadId, files = FILES) {
  for (const [name, body] of Object.entries(files)) {
    await store.put(keys.upload(postId, uploadId, `files/${name}`), Buffer.from(body));
  }
}

async function refusal(run) {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof BundleError, `threw a ${err.name}: ${err.message}`);
    return err;
  }
  assert.fail("the call was accepted");
}

// ------------------------------------------------------------- the happy path

test("a bundle is agreed, transferred, verified and promoted", async () => {
  const { store, interactives, signed, postId } = await harness();

  const agreed = await interactives.begin({ postId, manifest: manifest() });
  assert.equal(agreed.uploads.length, 4);
  assert.equal(agreed.revisionId, computeRevisionId(validateManifest(manifest(), { postId })));

  // Every signed URL covers a pending key and nothing else. The final keys are
  // never signed, so a URL still valid later cannot replace verified content.
  for (const { key, contentType, contentLength } of signed) {
    assert.match(key, /^uploads\/p_[0-9a-f]{16}\/u_[0-9a-f]{16}\/files\//, key);
    assert.ok(contentType, `${key} was signed without a content type`);
    assert.ok(Number.isInteger(contentLength), `${key} was signed without a length`);
  }

  await transfer(store, postId, agreed.uploadId);
  const record = await interactives.complete({ postId, uploadId: agreed.uploadId });

  assert.equal(record.status, "verified");
  assert.equal(record.name, "orbit");
  assert.equal(record.kind, "demo");
  for (const [name, body] of Object.entries(FILES)) {
    const object = await store.get(keys.interactiveFile(postId, record.id, record.revisionId, name));
    assert.ok(object, `${name} was not promoted`);
    assert.equal(object.body.toString("utf8"), body, `${name} was promoted with different bytes`);
  }
  assert.deepEqual((await interactives.list(postId)).map((r) => r.id), [record.id]);
});

test("a bundle keeps its own directory structure through the transfer", async () => {
  const { store, interactives, postId } = await harness();
  const nested = {
    "index.html": "<!doctype html><title>lab</title>",
    "fallback.html": "<p>fallback</p>",
    "lib/plot/draw.mjs": "export const draw = () => {};\n",
    "lib/data.json": "[1]",
  };
  const agreed = await interactives.begin({ postId, manifest: manifest({}, nested) });
  await transfer(store, postId, agreed.uploadId, nested);
  const record = await interactives.complete({ postId, uploadId: agreed.uploadId });

  // index.html says ./lib/plot/draw.mjs, so the key has to end in exactly that.
  const key = keys.interactiveFile(postId, record.id, record.revisionId, "lib/plot/draw.mjs");
  assert.ok(await store.get(key), "a nested file lost its path");
  assert.equal(classifyKey(key).name, "lib/plot/draw.mjs");
});

// ------------------------------------------------------------- what is refused

test("a file whose bytes disagree with its declared hash is refused", async () => {
  const { store, interactives, postId } = await harness();
  const agreed = await interactives.begin({ postId, manifest: manifest() });
  await transfer(store, postId, agreed.uploadId, { ...FILES, "data.json": '{"points":[9,9,9]}' });

  const error = await refusal(() => interactives.complete({ postId, uploadId: agreed.uploadId }));
  assert.equal(error.code, "hash_mismatch");
  // Nothing was promoted: the revision id names the declared bytes, so a
  // bundle that half-matches it must not exist at all.
  const promoted = await store.listAll(keys.interactivePrefix(postId));
  assert.deepEqual(promoted.filter(({ key }) => key.includes("/files/")), []);
});

test("a file of the wrong size is refused before it is read", async () => {
  const { store, interactives, postId } = await harness();
  const agreed = await interactives.begin({ postId, manifest: manifest() });
  await transfer(store, postId, agreed.uploadId, { ...FILES, "demo.mjs": "export const ready = false;;;;\n" });

  assert.equal((await refusal(() => interactives.complete({ postId, uploadId: agreed.uploadId }))).code,
    "size_mismatch");
});

test("a bundle missing a file it declared cannot complete", async () => {
  const { store, interactives, postId } = await harness();
  const agreed = await interactives.begin({ postId, manifest: manifest() });
  const { "data.json": _skipped, ...partial } = FILES;
  await transfer(store, postId, agreed.uploadId, partial);

  assert.equal((await refusal(() => interactives.complete({ postId, uploadId: agreed.uploadId }))).code,
    "upload_missing");
});

test("an upload signed for one post cannot be completed into another", async () => {
  const { store, interactives, postId } = await harness();
  const other = await harness();
  const agreed = await interactives.begin({ postId, manifest: manifest() });
  await transfer(store, postId, agreed.uploadId);

  assert.equal(
    (await refusal(() => other.interactives.complete({ postId: other.postId, uploadId: agreed.uploadId }))).code,
    "not_found"
  );
});

test("a manifest the contract refuses never reaches a signed URL", async () => {
  const { interactives, signed, postId } = await harness();
  const error = await refusal(() => interactives.begin({
    postId,
    manifest: manifest({ files: [{ name: "../escape.mjs", bytes: 1, sha256: "a".repeat(64) }] }),
  }));
  assert.equal(error.status, 422);
  assert.deepEqual(signed, [], "a refused bundle was signed anyway");
});

test("a bundle cannot be attached to a post with no draft", async () => {
  const { interactives } = await harness();
  assert.equal(
    (await refusal(() => interactives.begin({ postId: "p_00000000000000ff", manifest: manifest() }))).code,
    "not_found"
  );
});

// ------------------------------------------------------------- repeats

test("re-pushing an unchanged folder lands on the revision already stored", async () => {
  const { store, interactives, postId } = await harness();
  const first = await interactives.begin({ postId, manifest: manifest() });
  await transfer(store, postId, first.uploadId);
  const record = await interactives.complete({ postId, uploadId: first.uploadId });

  const again = await interactives.begin({ postId, manifest: manifest(), interactiveId: record.id });
  assert.equal(again.unchanged, true, "an identical bundle was offered a transfer");
  assert.deepEqual(again.uploads, []);
  assert.equal(again.revisionId, record.revisionId);
});

test("completing the same upload twice returns one bundle, not two", async () => {
  const { store, interactives, postId } = await harness();
  const agreed = await interactives.begin({ postId, manifest: manifest() });
  await transfer(store, postId, agreed.uploadId);

  const first = await interactives.complete({ postId, uploadId: agreed.uploadId });
  const second = await interactives.complete({ postId, uploadId: agreed.uploadId });
  assert.deepEqual(second, first);
  assert.equal((await interactives.list(postId)).length, 1);
});

test("a new revision of a bundle keeps the public name its first one claimed", async () => {
  const { store, interactives, postId } = await harness();
  const first = await interactives.begin({ postId, manifest: manifest() });
  await transfer(store, postId, first.uploadId);
  const original = await interactives.complete({ postId, uploadId: first.uploadId });

  const changed = { ...FILES, "data.json": '{"points":[4,5,6]}' };
  const second = await interactives.begin({
    postId, interactiveId: original.id, manifest: manifest({}, changed),
  });
  assert.notEqual(second.revisionId, original.revisionId, "changed bytes reused a revision");
  await transfer(store, postId, second.uploadId, changed);
  const updated = await interactives.complete({ postId, uploadId: second.uploadId });

  assert.equal(updated.id, original.id);
  assert.equal(updated.name, original.name, "a new revision moved the bundle's public path");
});

test("two interactives in one post cannot answer to the same public name", async () => {
  const { store, interactives, postId } = await harness();
  const first = await interactives.begin({ postId, manifest: manifest() });
  await transfer(store, postId, first.uploadId);
  const one = await interactives.complete({ postId, uploadId: first.uploadId });

  // A different bundle, same requested name.
  const otherFiles = { ...FILES, "data.json": '{"points":[7]}' };
  const second = await interactives.begin({ postId, manifest: manifest({}, otherFiles) });
  await transfer(store, postId, second.uploadId, otherFiles);
  const two = await interactives.complete({ postId, uploadId: second.uploadId });

  assert.notEqual(two.id, one.id);
  assert.equal(one.name, "orbit");
  assert.equal(two.name, "orbit-2", "two bundles would publish at one address");
});

// ------------------------------------------------------------- lifecycle

test("removing an interactive takes every revision, and keeps the name claimed", async () => {
  const { store, interactives, postId } = await harness();
  const agreed = await interactives.begin({ postId, manifest: manifest() });
  await transfer(store, postId, agreed.uploadId);
  const record = await interactives.complete({ postId, uploadId: agreed.uploadId });

  assert.deepEqual(await interactives.remove(postId, record.id), { removed: true, revisions: 1 });
  assert.deepEqual(await interactives.list(postId), []);
  assert.deepEqual(
    (await store.listAll(`${keys.interactivePrefix(postId)}${record.id}/`)).map(({ key }) => key), []
  );
  // The tombstone: a later bundle must never take this name and change what a
  // published URL shows.
  assert.ok(await store.getJson(keys.interactiveName(postId, "orbit")), "the name claim was released");
});

test("the per-post interactive limit holds", async () => {
  const { store, interactives, postId } = await harness();
  for (let i = 0; i < LIMITS.perPost; i++) {
    const files = { ...FILES, "data.json": `{"n":${i}}` };
    const agreed = await interactives.begin({ postId, manifest: manifest({}, files) });
    await transfer(store, postId, agreed.uploadId, files);
    await interactives.complete({ postId, uploadId: agreed.uploadId });
  }
  const over = { ...FILES, "data.json": '{"n":"over"}' };
  assert.equal((await refusal(() => interactives.begin({ postId, manifest: manifest({}, over) }))).code,
    "too_many_interactives");
});

test("an interrupted upload leaves files the collector sweeps, never a usable bundle", async () => {
  const { store, client, interactives, postId } = await harness();
  const agreed = await interactives.begin({ postId, manifest: manifest() });
  await transfer(store, postId, agreed.uploadId);

  // Promote the files by hand, then die before the manifest — the one window
  // where a bundle's files exist and its commit point does not.
  for (const [name, body] of Object.entries(FILES)) {
    await store.put(keys.interactiveFile(postId, agreed.interactiveId, agreed.revisionId, name), Buffer.from(body));
  }
  assert.deepEqual(await interactives.list(postId), [], "a bundle with no manifest was listed as verified");

  for (const value of client.objects.values()) {
    value.lastModified = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  }
  const swept = await collectGarbage(store, { apply: true });
  for (const name of Object.keys(FILES)) {
    const key = keys.interactiveFile(postId, agreed.interactiveId, agreed.revisionId, name);
    assert.ok(!(await store.get(key)), `an interrupted upload's file was kept forever: ${key}`);
  }
  assert.ok(swept.deleted > 0);
});

// -------------------------------------------------------------------- the route

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

const ORIGIN = "http://localhost:3000";
const uploadsRoute = (await import("../api/uploads/index.js")).default;

async function routeHarness() {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  const signed = [];
  const signPut = async (key) => { signed.push(key); return `https://signed.example/${encodeURIComponent(key)}`; };
  const { draft } = await createDraftStore(store).create({ title: "A post", body: "text" });

  const sessions = createSessionStore(store, { authVersion: 1 });
  const limiter = createRateLimiter(store, { secret: "test-secret" });
  setContext({ store, sessions, limiter, signPut });
  const { token, session } = await sessions.create();

  const call = async ({ method = "GET", url = "/api/uploads/", body, auth = true, csrf = true } = {}) => {
    const headers = { origin: ORIGIN };
    if (auth) headers.cookie = `${cookieName()}=${token}`;
    if (auth && csrf) headers["x-csrf-token"] = csrfToken(session);
    const res = fakeRes();
    await uploadsRoute({ method, url, headers, body }, res);
    return res;
  };
  return { store, signed, postId: draft.postId, call };
}

test("route: a bundle goes from manifest to verified record", async () => {
  const h = await routeHarness();

  const begun = await h.call({ method: "POST", body: { action: "begin-bundle", postId: h.postId, manifest: manifest() } });
  assert.equal(begun.statusCode, 200);
  const { uploadId, uploads } = begun.json();
  assert.equal(uploads.length, 4);

  await transfer(h.store, h.postId, uploadId);
  const done = await h.call({ method: "POST", body: { action: "complete-bundle", postId: h.postId, uploadId } });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().interactive.status, "verified");

  const listed = await h.call({ url: `/api/uploads/?postId=${h.postId}&kind=interactive` });
  assert.equal(listed.json().interactives.length, 1);
  // The attachment listing is a different question and must not have moved.
  assert.deepEqual((await h.call({ url: `/api/uploads/?postId=${h.postId}` })).json().attachments, []);
});

test("route: anonymous requests reach no bundle", async () => {
  const h = await routeHarness();
  for (const request of [
    { url: `/api/uploads/?postId=${h.postId}&kind=interactive` },
    { method: "POST", body: { action: "begin-bundle", postId: h.postId, manifest: manifest() } },
    { method: "POST", body: { action: "complete-bundle", postId: h.postId, uploadId: "u_0000000000000001" } },
    { method: "DELETE", url: `/api/uploads/?postId=${h.postId}&interactiveId=i_0000000000000001` },
  ]) {
    const res = await h.call({ ...request, auth: false });
    assert.equal(res.statusCode, 401, `${request.method ?? "GET"} was not refused`);
  }
  assert.deepEqual(h.signed, [], "an anonymous request was signed a URL");
});

test("route: a refusal carries its status and code, never a stack", async () => {
  const h = await routeHarness();
  const res = await h.call({
    method: "POST",
    body: { action: "begin-bundle", postId: h.postId, manifest: manifest({ kind: "widget" }) },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, "invalid_kind");
  assert.ok(!JSON.stringify(res.json()).includes("at Object."), "a stack reached the client");
});
