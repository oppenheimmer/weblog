// Tier 3/4 — attachment upload: sign, verify, promote (CLAUDE.md Step 4).
//
// Step 4's acceptance, case by case: forged types, wrong-owner ids, oversized
// files, replayed completions and post-verification replacement all fail
// safely. The replacement cases matter most — a presigned URL stays valid for
// its whole lifetime, so "the browser can PUT again after we checked" is not
// hypothetical, it is how the URL works.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads, UploadError, nthName, UPLOAD_URL_TTL_SECONDS } from "../lib/server/uploads.mjs";
import { keys, classifyKey } from "../lib/server/keys.mjs";
import { readR2Config } from "../lib/server/config.mjs";
import { uploadOrigin, editorCsp, pageHeaders } from "../lib/server/pages.mjs";
import { createSessionStore, csrfToken } from "../lib/server/sessions.mjs";
import { createRateLimiter } from "../lib/server/rate-limit.mjs";
import { setContext, cookieName } from "../lib/server/http.mjs";
import { MAX_ATTACHMENTS_PER_POST } from "../lib/attachments.mjs";
import { MAX_IMAGE_BYTES, MAX_TEX_BYTES } from "../lib/media.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const MEDIA = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "media");
const fixture = (name) => fs.readFileSync(path.join(MEDIA, name));
const PNG = fixture("sample-7x11.png");
const JPG = fixture("sample-13x5.jpg");
const TEX = fixture("snippet.tex");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

async function harness({ now } = {}) {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  const signed = [];
  const signPut = async (key, options) => {
    signed.push({ key, ...options });
    return `https://signed.test/${key}`;
  };
  const uploads = createUploads(store, { signPut, ...(now ? { now } : {}) });
  const drafts = createDraftStore(store);
  const { draft } = await drafts.create({ title: "Post", body: "x" });
  return { client, store, uploads, drafts, signed, signPut, postId: draft.postId };
}

/** What a browser does with a signed URL: put bytes at the pending key. */
const browserPut = (store, postId, uploadId, bytes) =>
  store.put(keys.upload(postId, uploadId, "file"), bytes);

async function attach(h, bytes, { name = "diagram.png", type = "image/png", kind = "image", postId = h.postId } = {}) {
  const signed = await h.uploads.sign({ postId, name, size: bytes.length, type, kind });
  await browserPut(h.store, postId, signed.uploadId, bytes);
  return h.uploads.complete({ postId, uploadId: signed.uploadId });
}

async function rejects(promise, code) {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err instanceof UploadError, `expected UploadError(${code}), got ${err?.name}: ${err?.message}`);
  assert.equal(err.code, code);
  return err;
}

const blobKeys = async (store, postId) =>
  (await store.listAll(keys.attachmentPrefix(postId)))
    .map(({ key }) => key)
    .filter((key) => classifyKey(key).kind === "attachment-blob");

// ------------------------------------------------------------------- signing

test("signing covers exactly one pending key, with its type and a short expiry", async () => {
  const h = await harness();
  const result = await h.uploads.sign({ postId: h.postId, name: "diagram.png", size: PNG.length, type: "image/png" });

  assert.equal(h.signed.length, 1);
  const [call] = h.signed;
  assert.equal(call.key, keys.upload(h.postId, result.uploadId, "file"));
  assert.ok(call.key.startsWith(`uploads/${h.postId}/`), "signed outside the post's upload prefix");
  assert.ok(!call.key.startsWith("attachments/"), "a verified-content key was signed for a browser PUT");
  assert.equal(call.contentType, "image/png");
  assert.equal(call.contentLength, PNG.length, "the URL does not fix the upload's size");
  assert.equal(call.expiresIn, UPLOAD_URL_TTL_SECONDS);
  assert.ok(UPLOAD_URL_TTL_SECONDS <= 600, "upload URLs are bearer tokens and must be short-lived");

  assert.equal(result.method, "PUT");
  assert.deepEqual(result.headers, { "content-type": "image/png" });
});

test("a draft must exist before anything can be attached", async () => {
  const h = await harness();
  await rejects(h.uploads.sign({ postId: "p_0000000000000999", name: "a.png", size: 10, type: "image/png" }), "not_found");
  await rejects(h.uploads.sign({ postId: "../../etc", name: "a.png", size: 10, type: "image/png" }), "invalid_post");
  assert.equal(h.signed.length, 0);
});

test("unsupported types and oversized files are refused before anything is signed", async () => {
  const h = await harness();
  const base = { postId: h.postId, name: "x", size: 100 };
  await rejects(h.uploads.sign({ ...base, type: "image/svg+xml" }), "unsupported_type");
  await rejects(h.uploads.sign({ ...base, type: "application/pdf" }), "unsupported_type");
  await rejects(h.uploads.sign({ ...base, type: "text/html" }), "unsupported_type");
  await rejects(h.uploads.sign({ ...base, type: "image/png", size: MAX_IMAGE_BYTES + 1 }), "too_large");
  await rejects(h.uploads.sign({ ...base, kind: "tex", size: MAX_TEX_BYTES + 1 }), "too_large");
  await rejects(h.uploads.sign({ ...base, type: "image/png", size: 0 }), "invalid_size");
  await rejects(h.uploads.sign({ ...base, type: "image/png", size: "12" }), "invalid_size");
  assert.equal(h.signed.length, 0, "a refused upload was signed anyway");
});

// ------------------------------------------------------------- verification

test("a verified image becomes an attachment with its real dimensions and hash", async () => {
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "Architecture Diagram.PNG", size: PNG.length, type: "image/png" });
  await browserPut(h.store, h.postId, signed.uploadId, PNG);
  const record = await h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId });

  assert.equal(record.id, signed.attachmentId);
  assert.equal(record.kind, "image");
  assert.equal(record.mediaType, "image/png");
  assert.equal(record.width, 7);
  assert.equal(record.height, 11);
  assert.equal(record.bytes, PNG.length);
  assert.equal(record.sha256, sha(PNG));
  assert.equal(record.status, "verified");
  assert.equal(record.publicName, "architecture-diagram.png");
  assert.equal(record.key, keys.attachmentBlob(h.postId, "architecture-diagram.png"));

  const blob = await h.store.get(record.key);
  assert.ok(blob.body.equals(PNG), "promoted bytes differ from what was verified");
  assert.equal(blob.contentType, "image/png", "stored type should be the sniffed one");

  assert.equal(await h.store.get(keys.upload(h.postId, signed.uploadId, "file")), null, "pending file left behind");
  assert.equal(await h.store.get(keys.uploadIntent(h.postId, signed.uploadId)), null, "intent left behind");
});

test("type and extension come from the bytes, not from what the browser claimed", async () => {
  const h = await harness();
  const record = await attach(h, JPG, { name: "photo.png", type: "image/png" });
  assert.equal(record.mediaType, "image/jpeg");
  assert.equal(record.publicName, "photo.jpg");
  assert.equal(record.width, 13);
  assert.equal(record.height, 5);
});

test("a forged file is refused, and nothing is promoted", async () => {
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "cute.png", size: SVG.length, type: "image/png" });
  await browserPut(h.store, h.postId, signed.uploadId, SVG);

  const err = await rejects(h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId }), "rejected");
  assert.equal(err.status, 422);
  assert.match(err.message, /not a PNG, JPEG, GIF or WebP/);

  assert.deepEqual(await h.uploads.list(h.postId), []);
  assert.deepEqual(await blobKeys(h.store, h.postId), []);
  assert.equal(await h.store.get(keys.upload(h.postId, signed.uploadId, "file")), null,
    "a rejected file was left in the bucket");
});

test("an oversized upload is refused from its metadata, without being read", async () => {
  // A presigned URL alone does not bound size unless content-length is signed.
  // Even so, the function must never discover an object's size by loading it.
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "a.png", size: PNG.length, type: "image/png" });
  const pendingKey = keys.upload(h.postId, signed.uploadId, "file");
  await h.store.put(pendingKey, Buffer.alloc(MAX_IMAGE_BYTES + 1));

  const reads = [];
  const watched = { ...h.store, get: async (key) => { reads.push(key); return h.store.get(key); } };
  const err = await rejects(
    createUploads(watched, { signPut: h.signPut }).complete({ postId: h.postId, uploadId: signed.uploadId }),
    "too_large"
  );
  assert.equal(err.status, 413);
  assert.ok(!reads.includes(pendingKey), "the oversized object was read into memory");
  assert.equal(await h.store.head(pendingKey), null, "the oversized object was left in the bucket");
});

test("an upload that is not the size agreed at signing is refused", async () => {
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "a.png", size: PNG.length, type: "image/png" });
  await browserPut(h.store, h.postId, signed.uploadId, JPG);
  await rejects(h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId }), "size_mismatch");
  assert.deepEqual(await h.uploads.list(h.postId), []);
});

test("binary declared as a .tex snippet is refused", async () => {
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "notes.tex", size: PNG.length, kind: "tex" });
  await browserPut(h.store, h.postId, signed.uploadId, PNG);
  await rejects(h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId }), "rejected");
});

test("completing before the file has arrived says so, and can be retried", async () => {
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "a.png", size: PNG.length, type: "image/png" });
  const early = await rejects(h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId }), "upload_missing");
  assert.equal(early.status, 409);

  await browserPut(h.store, h.postId, signed.uploadId, PNG);
  const record = await h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId });
  assert.equal(record.status, "verified");
});

test("an unknown or malformed upload id is refused", async () => {
  const h = await harness();
  await rejects(h.uploads.complete({ postId: h.postId, uploadId: "u_0000000000000999" }), "not_found");
  await rejects(h.uploads.complete({ postId: h.postId, uploadId: "../intent" }), "invalid_upload");
});

// ---------------------------------------------------------------- replay

test("completing twice returns the same attachment, not a second copy", async () => {
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "diagram.png", size: PNG.length, type: "image/png" });
  await browserPut(h.store, h.postId, signed.uploadId, PNG);
  const first = await h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId });
  const second = await h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId });

  assert.deepEqual(second, first);
  assert.equal((await h.uploads.list(h.postId)).length, 1);
  assert.deepEqual(await blobKeys(h.store, h.postId), [keys.attachmentBlob(h.postId, "diagram.png")]);
});

test("replaying the signed URL after verification cannot change the attachment", async () => {
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "diagram.png", size: PNG.length, type: "image/png" });
  await browserPut(h.store, h.postId, signed.uploadId, PNG);
  const record = await h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId });

  // The URL is still valid: someone holding it PUTs different bytes, then
  // completes again hoping for a re-verification that swaps the content.
  await browserPut(h.store, h.postId, signed.uploadId, SVG);
  const again = await h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId });

  assert.equal(again.sha256, sha(PNG));
  const blob = await h.store.get(record.key);
  assert.ok(blob.body.equals(PNG), "the verified attachment was replaced through a replayed upload URL");
});

test("promotion writes the bytes that were verified, not a later read of the pending key", async () => {
  // The narrowest version of the race: bytes are swapped at the pending key
  // in the instant after they are read for verification.
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "diagram.png", size: PNG.length, type: "image/png" });
  await browserPut(h.store, h.postId, signed.uploadId, PNG);

  const pendingKey = keys.upload(h.postId, signed.uploadId, "file");
  const racing = {
    ...h.store,
    async get(key) {
      const object = await h.store.get(key);
      if (key === pendingKey) await h.store.put(pendingKey, SVG);
      return object;
    },
  };
  const record = await createUploads(racing, { signPut: h.signPut })
    .complete({ postId: h.postId, uploadId: signed.uploadId });

  assert.equal(record.sha256, sha(PNG));
  assert.ok((await h.store.get(record.key)).body.equals(PNG), "promotion re-read the pending key");
});

test("an upload signed for one post cannot be completed into another", async () => {
  const h = await harness();
  const { draft: other } = await h.drafts.create({ title: "Other" });
  const signed = await h.uploads.sign({ postId: h.postId, name: "a.png", size: PNG.length, type: "image/png" });
  await browserPut(h.store, h.postId, signed.uploadId, PNG);

  await rejects(h.uploads.complete({ postId: other.postId, uploadId: signed.uploadId }), "not_found");
  assert.deepEqual(await h.uploads.list(other.postId), []);
});

// ------------------------------------------------------------------- naming

test("nthName suffixes before the extension", () => {
  assert.equal(nthName("diagram.png", 1), "diagram.png");
  assert.equal(nthName("diagram.png", 2), "diagram-2.png");
  assert.equal(nthName("archive.tar.gz", 3), "archive.tar-3.gz");
  assert.equal(nthName("noext", 2), "noext-2");
});

test("two files with the same name get distinct public names", async () => {
  const h = await harness();
  const a = await attach(h, PNG, { name: "image.png" });
  const b = await attach(h, PNG, { name: "image.png" });
  assert.equal(a.publicName, "image.png");
  assert.equal(b.publicName, "image-2.png");
});

test("concurrent uploads racing for one name cannot both win", async () => {
  // Every clipboard paste is called image.png, so this is the common case.
  const h = await harness();
  const signs = await Promise.all([1, 2, 3].map(() =>
    h.uploads.sign({ postId: h.postId, name: "image.png", size: PNG.length, type: "image/png" })));
  for (const s of signs) await browserPut(h.store, h.postId, s.uploadId, PNG);

  const records = await Promise.all(signs.map((s) =>
    h.uploads.complete({ postId: h.postId, uploadId: s.uploadId })));
  const names = records.map((r) => r.publicName);
  assert.equal(new Set(names).size, 3, `names collided: ${names.join(", ")}`);
});

test("an interrupted completion is finished by a retry, without a suffixed stray", async () => {
  const h = await harness();
  const signed = await h.uploads.sign({ postId: h.postId, name: "diagram.png", size: PNG.length, type: "image/png" });
  await browserPut(h.store, h.postId, signed.uploadId, PNG);

  // A first attempt that claimed the name and wrote the file, then died
  // before writing its record.
  await h.store.createJson(keys.attachmentName(h.postId, "diagram.png"), { attachmentId: signed.attachmentId });
  await h.store.put(keys.attachmentBlob(h.postId, "diagram.png"), PNG);

  const record = await h.uploads.complete({ postId: h.postId, uploadId: signed.uploadId });
  assert.equal(record.publicName, "diagram.png", "the retry did not reuse its own claim");
  assert.deepEqual(await blobKeys(h.store, h.postId), [keys.attachmentBlob(h.postId, "diagram.png")]);
});

test("a removed attachment's name is never reused, so a published URL never changes", async () => {
  const h = await harness();
  const first = await attach(h, PNG, { name: "diagram.png" });
  assert.deepEqual(await h.uploads.remove(h.postId, first.id), { removed: true });

  assert.equal(await h.store.get(keys.attachmentRecord(h.postId, first.id)), null);
  assert.equal(await h.store.get(first.key), null);
  assert.ok(await h.store.get(keys.attachmentName(h.postId, "diagram.png")), "the name tombstone was deleted");

  const second = await attach(h, JPG, { name: "diagram.png", type: "image/jpeg" });
  const third = await attach(h, PNG, { name: "diagram.png" });
  assert.equal(second.publicName, "diagram.jpg");
  assert.equal(third.publicName, "diagram-2.png", "a removed attachment's name was handed out again");
});

test("removing an attachment that does not exist is a no-op", async () => {
  const h = await harness();
  assert.deepEqual(await h.uploads.remove(h.postId, "a_0000000000000999"), { removed: false });
  await rejects(h.uploads.remove(h.postId, "../../x"), "invalid_attachment");
});

// ------------------------------------------------------------------- limits

test("the per-post attachment limit holds at completion, not only at signing", async () => {
  const h = await harness();
  for (let i = 0; i < MAX_ATTACHMENTS_PER_POST - 1; i++) await attach(h, PNG, { name: `f${i}.png` });

  // Both are signed while there is still room for one of them.
  const a = await h.uploads.sign({ postId: h.postId, name: "a.png", size: PNG.length, type: "image/png" });
  const b = await h.uploads.sign({ postId: h.postId, name: "b.png", size: PNG.length, type: "image/png" });
  await browserPut(h.store, h.postId, a.uploadId, PNG);
  await browserPut(h.store, h.postId, b.uploadId, PNG);

  await h.uploads.complete({ postId: h.postId, uploadId: a.uploadId });
  await rejects(h.uploads.complete({ postId: h.postId, uploadId: b.uploadId }), "too_many_attachments");
  assert.equal((await h.uploads.list(h.postId)).length, MAX_ATTACHMENTS_PER_POST);
  await rejects(h.uploads.sign({ postId: h.postId, name: "c.png", size: 10, type: "image/png" }), "too_many_attachments");
});

// -------------------------------------------------------------- tex snippets

test("a .tex snippet is stored as text and its content is retrievable", async () => {
  const h = await harness();
  const record = await attach(h, TEX, { name: "snippet.tex", kind: "tex" });
  assert.equal(record.kind, "tex");
  assert.equal(record.mediaType, "text/x-tex");
  assert.equal(record.publicName, "snippet.tex");
  assert.equal(record.width, undefined);

  const texts = await h.uploads.snippetTexts(h.postId, await h.uploads.list(h.postId));
  assert.match(texts.get(record.id), /\\section\{A snippet\}/);
});

test("list returns only this post's records, oldest first", async () => {
  let clock = Date.parse("2026-09-11T00:00:00Z");
  const h = await harness({ now: () => new Date(clock += 1000) });
  const a = await attach(h, PNG, { name: "a.png" });
  const b = await attach(h, JPG, { name: "b.jpg", type: "image/jpeg" });
  const { draft: other } = await h.drafts.create({ title: "Other" });
  await attach(h, PNG, { name: "c.png", postId: other.postId });

  assert.deepEqual((await h.uploads.list(h.postId)).map((r) => r.id), [a.id, b.id]);
});

test("uploads completed in the same millisecond list in an order the store does not decide", async () => {
  // The test above once failed: two uploads in one millisecond tie on
  // createdAt, and a tie fell back to the store's listing order — id order, not
  // upload order. The tie-break states that order instead of inheriting it.
  // Listing through a store that returns keys in reverse is what proves it:
  // against a lexicographic store alone, deleting the tie-break went unnoticed.
  const frozen = new Date("2026-09-11T00:00:00Z");
  const h = await harness({ now: () => frozen });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await attach(h, PNG, { name: `same-${i}.png` })).id);

  const reversed = { ...h.store, listAll: async (prefix) => (await h.store.listAll(prefix)).reverse() };
  const listed = (await createUploads(reversed, { signPut: h.signPut }).list(h.postId)).map((r) => r.id);
  assert.deepEqual(listed, [...ids].sort());
});

test("every attachment key is owned by its post, so garbage collection needs no new rule", () => {
  const post = "p_00000000000000aa";
  for (const [key, kind] of [
    [keys.attachmentRecord(post, "a_00000000000000a1"), "attachment-record"],
    [keys.attachmentBlob(post, "diagram.png"), "attachment-blob"],
    [keys.attachmentName(post, "diagram.png"), "attachment-name"],
    [keys.uploadIntent(post, "u_00000000000000a1"), "upload"],
  ]) {
    const info = classifyKey(key);
    assert.equal(info.kind, kind, key);
    assert.equal(info.owned, true, key);
    assert.equal(info.postId, post, key);
  }
});

// ----------------------------------------------------------- browser policy

test("the editor CSP admits exactly the origin real presigned URLs are sent to", async () => {
  // A connect-src naming the endpoint rather than the bucket's virtual host
  // blocks every upload in the browser, and no server-side test notices. So
  // this compares against a URL the real signer produced (offline).
  const env = {
    R2_ACCOUNT_ID: "acct0123456789abcdef", R2_BUCKET: "weblog-data",
    R2_ACCESS_KEY_ID: "AKIAEXAMPLE", R2_SECRET_ACCESS_KEY: "example-secret",
  };
  const store = createStore({ config: readR2Config(env) });
  const url = new URL(await store.signPut("uploads/p_0000000000000000/u_0000000000000000/file", {
    contentType: "image/png",
    contentLength: 1234,
  }));

  assert.equal(uploadOrigin(env), url.origin);
  assert.match(url.searchParams.get("X-Amz-SignedHeaders"), /content-type/,
    "content-type is not part of the signature, so the URL accepts any type");
  assert.match(url.searchParams.get("X-Amz-SignedHeaders"), /content-length/,
    "content-length is not part of the signature, so the URL accepts any size");
  assert.ok(editorCsp({ upload: url.origin }).includes(`connect-src 'self' ${url.origin}`));
});

test("only the editor page may talk to storage", () => {
  assert.ok(!pageHeaders()["content-security-policy"].includes("cloudflarestorage"),
    "the login page CSP admits the storage origin");
  assert.equal(editorCsp(), editorCsp({ upload: null }));
});

// --------------------------------------------------------------------- route

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
  const h = await harness();
  const sessions = createSessionStore(h.store, { authVersion: 1 });
  const limiter = createRateLimiter(h.store, { secret: "test-secret" });
  setContext({ store: h.store, sessions, limiter, signPut: h.signPut });
  const { token, session } = await sessions.create();
  const call = async ({ method = "GET", url = "/api/uploads/", body, auth = true, csrf = true } = {}) => {
    const headers = { origin: ORIGIN };
    if (auth) headers.cookie = `${cookieName()}=${token}`;
    if (auth && csrf) headers["x-csrf-token"] = csrfToken(session);
    const res = fakeRes();
    await uploadsRoute({ method, url, headers, body }, res);
    return res;
  };
  return { ...h, call };
}

test("route: anonymous requests reach nothing", async () => {
  const h = await routeHarness();
  for (const request of [
    { method: "GET", url: `/api/uploads/?postId=${h.postId}` },
    { method: "POST", body: { action: "sign", postId: h.postId, name: "a.png", size: 10, type: "image/png" } },
    { method: "DELETE", url: `/api/uploads/?postId=${h.postId}&attachmentId=a_0000000000000001` },
  ]) {
    const res = await h.call({ ...request, auth: false });
    assert.equal(res.statusCode, 401, `${request.method} was not refused`);
  }
  assert.equal(h.signed.length, 0);
});

test("route: signing without a CSRF token is refused", async () => {
  const h = await routeHarness();
  const res = await h.call({
    method: "POST", csrf: false,
    body: { action: "sign", postId: h.postId, name: "a.png", size: 10, type: "image/png" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(h.signed.length, 0);
});

test("route: sign, transfer, complete, list and remove, end to end", async () => {
  const h = await routeHarness();

  const signed = await h.call({
    method: "POST", body: { action: "sign", postId: h.postId, name: "diagram.png", size: PNG.length, type: "image/png" },
  });
  assert.equal(signed.statusCode, 200);
  const { uploadId, url } = signed.json();
  assert.match(url, /^https:\/\/signed\.test\//);

  await browserPut(h.store, h.postId, uploadId, PNG);

  const completed = await h.call({ method: "POST", body: { action: "complete", postId: h.postId, uploadId } });
  assert.equal(completed.statusCode, 200);
  const { attachment } = completed.json();
  assert.equal(attachment.width, 7);

  const listed = await h.call({ url: `/api/uploads/?postId=${h.postId}` });
  assert.deepEqual(listed.json().attachments.map((a) => a.id), [attachment.id]);

  const removed = await h.call({ method: "DELETE", url: `/api/uploads/?postId=${h.postId}&attachmentId=${attachment.id}` });
  assert.deepEqual(removed.json(), { removed: true });
  assert.deepEqual((await h.call({ url: `/api/uploads/?postId=${h.postId}` })).json().attachments, []);
});

test("route: refusals carry their status and code, never a stack", async () => {
  const h = await routeHarness();
  const res = await h.call({
    method: "POST", body: { action: "sign", postId: h.postId, name: "x.svg", size: 10, type: "image/svg+xml" },
  });
  assert.equal(res.statusCode, 415);
  const body = res.json();
  assert.equal(body.code, "unsupported_type");
  assert.ok(body.requestId);
  assert.ok(!JSON.stringify(body).includes("at "), "a stack trace leaked");

  const unknown = await h.call({ method: "POST", body: { action: "explode" } });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().code, "unknown_action");
});
