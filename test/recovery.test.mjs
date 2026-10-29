import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createStore, ConflictError } from "../lib/server/r2.mjs";
import { createDraftStore, CREATE_REQUEST_TTL_MS } from "../lib/server/drafts.mjs";
import { keys } from "../lib/server/keys.mjs";
import { buildInventory, collectableForPost } from "../lib/server/inventory.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";
import { sourceFields, transientSaveError } from "../assets/recovery.mjs";

function setup() {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  return { store, drafts: createDraftStore(store), requestId: `${Date.now()}-${crypto.randomUUID()}` };
}

test("a lost create response can be replayed across cold starts without another post or revision", async () => {
  const { store, drafts, requestId } = setup();
  const first = await drafts.create({ title: "Recover me", body: "source" }, { requestId });
  const retry = await createDraftStore(store).create({ title: "Recover me", body: "source" }, { requestId });
  assert.equal(retry.replayed, true);
  assert.equal(retry.draft.postId, first.draft.postId);
  assert.equal(retry.etag, first.etag);
  assert.equal((await drafts.list()).length, 1);
  assert.equal((await drafts.revisions(first.draft.postId)).length, 1);
});

test("concurrent creates with one request identity converge on one pointer and immutable revision", async () => {
  const { store, drafts, requestId } = setup();
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => createDraftStore(store).create({ body: "one" }, { requestId })));
  assert.equal(new Set(outcomes.map((r) => r.draft.postId)).size, 1);
  assert.equal(new Set(outcomes.map((r) => r.etag)).size, 1);
  assert.equal((await drafts.revisions(outcomes[0].draft.postId)).length, 1);
});

test("replaying creation returns later edits without overwriting them", async () => {
  const { drafts, requestId } = setup();
  const first = await drafts.create({ body: "first" }, { requestId });
  const later = await drafts.save(first.draft.postId, { body: "other tab" }, first.etag);
  const retry = await drafts.create({ body: "first" }, { requestId });
  assert.equal(retry.draft.body, "other tab");
  assert.equal(retry.etag, later.etag);
  await assert.rejects(drafts.save(first.draft.postId, { body: "stale" }, first.etag), ConflictError);
});

test("creation identities cannot be reused with different source", async () => {
  const { drafts, requestId } = setup();
  await drafts.create({ body: "first" }, { requestId });
  await assert.rejects(drafts.create({ body: "changed" }, { requestId }), { status: 409, code: "creation_mismatch" });
});

test("discard keeps a content-free receipt and delayed create cannot resurrect the post", async () => {
  const { store, drafts, requestId } = setup();
  const { draft } = await drafts.create({ body: "private text" }, { requestId });
  await drafts.remove(draft.postId);
  assert.equal(await drafts.get(draft.postId), null);
  const objects = await store.listAll(keys.draftPrefix(draft.postId));
  assert.deepEqual(objects.map((o) => o.key).sort(), [keys.draftCreation(draft.postId), keys.draftPointer(draft.postId)].sort());
  const receipt = (await store.getJson(objects[0].key)).data;
  assert.equal(receipt.state, "deleted");
  assert.ok(!JSON.stringify(receipt).includes("private text"));
  await assert.rejects(drafts.create({ body: "private text" }, { requestId }), { status: 410, code: "creation_deleted" });
});

test("creation receipts survive orphan collection until requests have expired", async () => {
  const { store, drafts, requestId } = setup();
  const { draft } = await drafts.create({ body: "retain receipt" }, { requestId });
  await drafts.remove(draft.postId);
  const inventory = await buildInventory(store);
  const record = inventory.posts.find((p) => p.postId === draft.postId);
  assert.ok(record, "receipt must be visible to the inventory");
  assert.deepEqual(collectableForPost(record, { now: Date.now() + 2 * 86400_000 }), []);
  assert.deepEqual(collectableForPost(record, { now: Date.now() + 9 * 86400_000 }).map((o) => o.key).sort(), [keys.draftCreation(draft.postId), keys.draftPointer(draft.postId)].sort());
});

test("a create replay already in flight cannot recreate a concurrently discarded pointer", async () => {
  const { store, drafts, requestId } = setup();
  const { draft } = await drafts.create({ body: "original" }, { requestId });
  // Model a process that committed its pointer but stopped before marking its
  // receipt complete, then a replay paused while the owner discards the draft.
  await store.mutateJson(keys.draftCreation(draft.postId), (r) => ({ ...r, state: "pending" }));
  const get = store.getJson.bind(store);
  let release, reached;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const pause = new Promise((resolve) => { release = resolve; });
  let held = false;
  store.getJson = async (key) => {
    if (key === keys.draftPointer(draft.postId) && !held) { held = true; reached(); await pause; }
    return get(key);
  };
  const replay = drafts.create({ body: "original" }, { requestId });
  const refused = assert.rejects(replay, { status: 410, code: "creation_deleted" });
  await waiting;
  await drafts.remove(draft.postId);
  release(); await refused;
  assert.equal(await drafts.get(draft.postId), null);
  assert.equal((await drafts.list()).length, 0);
});

test("expired or malformed creation identities are refused before writing objects", async () => {
  const { store, drafts } = setup();
  for (const requestId of ["bad", null, 1, `${Date.now() - CREATE_REQUEST_TTL_MS}-${crypto.randomUUID()}`, `${Date.now() + 600_000}-${crypto.randomUUID()}`]) {
    await assert.rejects(drafts.create({ body: "x" }, { requestId }), { status: 410 });
  }
  assert.equal((await store.listAll("drafts/")).length, 0);
});

test("interrupted pointer creation resumes the same immutable revision", async () => {
  const { store, drafts, requestId } = setup();
  const create = store.createJson.bind(store);
  let interrupted = false;
  store.createJson = async (key, value) => {
    if (key.endsWith("/current.json") && !interrupted) { interrupted = true; throw new Error("interrupted"); }
    return create(key, value);
  };
  await assert.rejects(drafts.create({ body: "x" }, { requestId }), /interrupted/);
  const recovered = await drafts.create({ body: "x" }, { requestId });
  assert.equal(recovered.draft.body, "x");
  assert.equal((await drafts.revisions(recovered.draft.postId)).length, 1);
});

test("device field projection excludes credentials, private server metadata and asset URLs", () => {
  assert.deepEqual(Object.keys(sourceFields({ body: "text", csrfToken: "secret", password: "secret", assets: ["signed URL"], revisionId: "r_private" })),
    ["title", "date", "format", "slug", "description", "tags", "body"]);
});

test("retry classification excludes authentication, conflicts, validation and permanent refusals", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(transientSaveError({ status }), true);
  for (const status of [400, 401, 403, 404, 409, 410, 413, 422]) assert.equal(transientSaveError({ status }), false);
  assert.equal(transientSaveError(new TypeError("offline")), true);
  assert.equal(transientSaveError(new DOMException("deadline", "TimeoutError")), true);
});
