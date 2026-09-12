// Tier 3 — what Publish will do, said before it is pressed (CLAUDE.md Step 5).
//
// The promise is agreement, not advice. Readiness is decided by the same
// function publishing uses before its first write, so every case here asks the
// check and then really publishes the same draft: a post the check calls ready
// must publish with exactly the images and bundles the check named, and one it
// refuses must be refused by publishing with the same code.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads } from "../lib/server/uploads.mjs";
import { createInteractives } from "../lib/server/interactives.mjs";
import { createPublisher, PublishError, INDEX_KEY } from "../lib/server/publish.mjs";
import { keys } from "../lib/server/keys.mjs";
import { createSessionStore, csrfToken } from "../lib/server/sessions.mjs";
import { createRateLimiter } from "../lib/server/rate-limit.mjs";
import { setContext, cookieName } from "../lib/server/http.mjs";
import publishRoute from "../api/publish.js";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const PNG = fs.readFileSync(new URL("./fixtures/media/sample-7x11.png", import.meta.url));
const TEX = fs.readFileSync(new URL("./fixtures/media/snippet.tex", import.meta.url));

function harness() {
  const client = createFakeS3();
  // Classify every call, so "a check writes nothing" and its cost are measured.
  const calls = [];
  const counting = {
    objects: client.objects,
    send(command) {
      calls.push(command.constructor.name);
      return client.send(command);
    },
  };
  const store = createStore({ config: FAKE_CONFIG, client: counting });
  const signPut = async (key) => `https://signed.test/${key}`;
  const uploads = createUploads(store, { signPut });
  const interactives = createInteractives(store, { signPut });
  const publisher = createPublisher(store, {
    uploads, interactives,
    fireDeployHook: async () => ({}),
    housekeep: async () => ({ ok: true, swept: { deleted: 0, bytesFreed: 0 } }),
  });
  return { store, client, calls, uploads, interactives, publisher, drafts: createDraftStore(store) };
}

async function attach(h, postId, { name, bytes, kind = "image", type = "image/png" }) {
  const signed = await h.uploads.sign({ postId, name, size: bytes.length, type, kind });
  await h.store.put(keys.upload(postId, signed.uploadId, "file"), bytes);
  return h.uploads.complete({ postId, uploadId: signed.uploadId });
}

async function draftWith(h, fields) {
  const { draft, etag } = await h.drafts.create({ title: "A post", date: "2026-07-01", body: "seed", ...fields });
  return { draft, etag };
}

async function save(h, postId, fields) {
  const current = await h.drafts.get(postId);
  return (await h.drafts.save(postId, fields, current.etag)).draft;
}

/** Ask the check, then really publish, and require that the two agree. */
async function agree(h, draft) {
  const check = await h.publisher.check(draft);
  let published = null;
  let refused = null;
  try {
    await h.publisher.publish(draft);
    const entry = (await h.store.getJson(INDEX_KEY)).data.posts[check.slug ?? draft.slug];
    published = (await h.store.getJson(keys.publishedRevision(draft.postId, entry.revisionId))).data;
  } catch (err) {
    if (!(err instanceof PublishError)) throw err;
    refused = err;
  }

  if (check.ready) {
    assert.ok(published, `the check said ready, but publishing refused: ${refused?.code} ${refused?.message}`);
    assert.equal(check.url, `/${published.slug}/`);
    assert.deepEqual(check.media, published.media.map((m) => m.publicName));
    assert.deepEqual(check.interactives,
      (published.interactives ?? []).map(({ kind, name }) => ({ kind, name })));
  } else {
    assert.ok(refused, `the check refused (${check.refusal.code}), but publishing succeeded`);
    assert.equal(check.refusal.code, refused.code);
    assert.equal(check.refusal.message, refused.message);
    assert.equal(check.refusal.field, refused.field ?? null);
  }
  return check;
}

// ---------------------------------------------------------------- ready

test("a post with an image and a snippet is ready, naming both and what goes unused", async () => {
  const h = harness();
  const { draft } = await draftWith(h, {});
  const image = await attach(h, draft.postId, { name: "diagram.png", bytes: PNG });
  const snippet = await attach(h, draft.postId, { name: "gauss.tex", bytes: TEX, kind: "tex", type: "text/x-tex" });
  await attach(h, draft.postId, { name: "spare.png", bytes: PNG });
  const ready = await save(h, draft.postId,
    { body: `Text.\n\n![a diagram](attachment://${image.id})\n\n::tex[${snippet.id}]\n` });

  const check = await agree(h, ready);
  assert.equal(check.ready, true);
  assert.deepEqual(check.media, ["diagram.png"]);
  assert.deepEqual(check.snippets, ["gauss.tex"]);
  assert.deepEqual(check.unused, ["spare.png"]);
});

test("a reference that appears only inside code is not counted, and the post is ready", async () => {
  const h = harness();
  const { draft } = await draftWith(h, { body: "Write `![x](attachment://a_0000000000000000)` to embed one." });
  const check = await agree(h, draft);
  assert.equal(check.ready, true);
  assert.deepEqual(check.media, []);
});

test("a publication-only post keeps its public images, and the check says so", async () => {
  const h = harness();
  const { draft } = await draftWith(h, { slug: "kept" });
  const image = await attach(h, draft.postId, { name: "diagram.png", bytes: PNG });
  const withImage = await save(h, draft.postId, { body: `![d](attachment://${image.id})` });
  await h.publisher.publish(withImage);
  // What migration left behind: a publication with media, and no draft or
  // attachment records to resolve against.
  for (const { key } of [...await h.store.listAll(keys.draftPrefix(draft.postId)),
    ...await h.store.listAll(keys.attachmentPrefix(draft.postId))]) {
    await h.store.delete(key);
  }
  const entry = (await h.store.getJson(INDEX_KEY)).data.posts.kept;
  const { draft: branched } = await h.drafts.branchPublished(draft.postId, entry.revisionId);
  const edited = await save(h, draft.postId, { body: `${branched.body}\n\nA new line.` });

  const check = await agree(h, edited);
  assert.equal(check.ready, true);
  assert.deepEqual(check.media, ["diagram.png"]);
});

test("an unsaved post with plain text is ready at the address its title gives it", async () => {
  const h = harness();
  const check = await h.publisher.check({ title: "Fresh words", date: "2026-07-01", body: "Hello.", slug: "fresh-words", format: "markdown" });
  assert.deepEqual([check.ready, check.url, check.media], [true, "/fresh-words/", []]);
});

// ---------------------------------------------------------------- not ready

test("a reference to an attachment the post does not have is refused, as publishing refuses it", async () => {
  const h = harness();
  const { draft } = await draftWith(h, { body: "![gone](attachment://a_0000000000000000)" });
  const check = await agree(h, draft);
  assert.equal(check.refusal.code, "unknown_attachment");
});

test("an unsaved post naming an attachment is refused before it is ever saved", async () => {
  // Publish saves first, creating a post with no attachments, and then refuses.
  const h = harness();
  const fields = { title: "Fresh", date: "2026-07-01", body: "![x](attachment://a_0000000000000000)", slug: "fresh", format: "markdown" };
  const check = await h.publisher.check(fields);
  const { draft } = await h.drafts.create(fields);
  const err = await h.publisher.publish(draft).then(() => null, (e) => e);
  assert.equal(check.ready, false);
  assert.equal(check.refusal.code, err?.code);
});

test("a missing title, a reserved address and an unattached lab are refused with publishing's codes", async () => {
  for (const fields of [
    { title: "" },
    { slug: "api" },
    { body: "::demo[i_0000000000000000]" },
  ]) {
    const h = harness();
    const { draft } = await draftWith(h, fields);
    const check = await agree(h, draft);
    assert.equal(check.ready, false, JSON.stringify(fields));
  }
});

test("an address another post holds is refused before anything is written", async () => {
  const h = harness();
  const { draft: other } = await draftWith(h, { slug: "taken", body: "First." });
  await h.publisher.publish(other);
  const { draft } = await draftWith(h, { slug: "taken", body: "Second." });
  const check = await agree(h, draft);
  assert.equal(check.refusal.code, "slug_taken");
});

test("a published post's address is locked, and the check says so on the slug field", async () => {
  const h = harness();
  const { draft } = await draftWith(h, { slug: "fixed" });
  await h.publisher.publish(draft);
  const moved = await save(h, draft.postId, { slug: "moved" });
  const check = await agree(h, moved);
  assert.deepEqual([check.refusal.code, check.refusal.field], ["slug_locked", "slug"]);
});

// ---------------------------------------------------------------- cost

test("a check writes nothing, and its only listings are the post's attachments and bundles", async () => {
  const h = harness();
  const { draft } = await draftWith(h, {});
  const image = await attach(h, draft.postId, { name: "diagram.png", bytes: PNG });
  const ready = await save(h, draft.postId, { body: `![d](attachment://${image.id})` });

  h.calls.length = 0;
  await h.publisher.check(ready);
  const writes = h.calls.filter((name) => /^(Put|Delete|Copy)/.test(name));
  const lists = h.calls.filter((name) => /^List/.test(name));
  assert.deepEqual(writes, []);
  assert.equal(lists.length, 2, h.calls.join(", "));
});

// ---------------------------------------------------------------- the route

function routeHarness() {
  const h = harness();
  const sessions = createSessionStore(h.store, { authVersion: 1 });
  setContext({ log: () => {}, store: h.store, sessions, limiter: createRateLimiter(h.store, { secret: "readiness" }) });
  process.env.SITE_URL = "https://blog.example";
  return { ...h, sessions };
}

async function callRoute(h, body) {
  const { token, session } = await h.sessions.create();
  const res = {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    end(chunk) { this.body = chunk; },
  };
  await publishRoute({
    method: "POST", url: "/api/publish/", body,
    headers: {
      cookie: `${cookieName()}=${token}`, origin: "https://blog.example",
      "x-csrf-token": csrfToken(session), "content-type": "application/json",
    },
  }, res);
  return { status: res.statusCode, json: JSON.parse(res.body ?? "null") };
}

test("the route checks the fields on screen, taking the post's history from its stored draft", async () => {
  const h = routeHarness();
  const { draft } = await draftWith(h, { slug: "screen" });
  const { status, json } = await callRoute(h, {
    action: "check", postId: draft.postId, title: "On screen", date: "2026-07-01",
    body: "Unsaved text.", slug: "screen", format: "markdown",
    // A browser cannot hand the check a published revision to inherit from.
    publishedRevisionId: "r_000001_forged_000000",
  });
  assert.equal(status, 200);
  assert.deepEqual([json.ready, json.url], [true, "/screen/"]);
  assert.equal((await h.store.listAll("publications/")).length, 0, "a check started a publication");
});

test("with publishing disabled the check says so rather than promising a publish", async () => {
  const h = routeHarness();
  process.env.PUBLISH_ENABLED = "false";
  try {
    const { json } = await callRoute(h, {
      action: "check", title: "A", date: "2026-07-01", body: "Text.", slug: "a", format: "markdown",
    });
    assert.deepEqual([json.ready, json.refusal?.code], [false, "publish_disabled"]);
  } finally {
    delete process.env.PUBLISH_ENABLED;
  }
});
