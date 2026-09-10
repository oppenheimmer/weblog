// Tier 5 — draft persistence and optimistic concurrency.
//
// The acceptance criterion for Step 2 is that drafts survive a cold restart and
// that two tabs editing the same version get an explicit conflict rather than
// one silently destroying the other's work. Both are asserted here.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, ConflictError } from "../lib/server/r2.mjs";
import { createDraftStore, normalizeDraftInput, DraftError, newRevisionId } from "../lib/server/drafts.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

function newDrafts() {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  return { drafts: createDraftStore(store), store, client };
}

// ---------------------------------------------------------------- validation

test("a blank draft is valid — drafts are works in progress", () => {
  const fields = normalizeDraftInput({});
  assert.equal(fields.title, "");
  assert.equal(fields.date, "");
  assert.equal(fields.format, "markdown");
  assert.deepEqual(fields.tags, []);
});

test("shape is enforced even though absence is allowed", () => {
  assert.throws(() => normalizeDraftInput({ title: 42 }), DraftError);
  assert.throws(() => normalizeDraftInput({ tags: "not-an-array" }), DraftError);
  assert.throws(() => normalizeDraftInput({ body: {} }), DraftError);
  assert.throws(() => normalizeDraftInput({ format: "docx" }), DraftError);
  assert.throws(() => normalizeDraftInput({ title: "x".repeat(301) }), DraftError);
  assert.throws(() => normalizeDraftInput({ tags: Array(21).fill("t") }), DraftError);
});

test("dates must be real calendar dates in ISO form", () => {
  assert.equal(normalizeDraftInput({ date: "2026-07-01" }).date, "2026-07-01");
  assert.equal(normalizeDraftInput({ date: "" }).date, "");
  assert.throws(() => normalizeDraftInput({ date: "01/07/2026" }), DraftError);
  assert.throws(() => normalizeDraftInput({ date: "2026-13-01" }), DraftError);
  assert.throws(() => normalizeDraftInput({ date: "2026-02-30" }), DraftError);
});

test("slug is derived from the title until one is set explicitly", () => {
  assert.equal(normalizeDraftInput({ title: "Hello There World" }).slug, "hello-there-world");
  assert.equal(normalizeDraftInput({ title: "Ignored", slug: "Explicit Slug" }).slug, "explicit-slug");
});

test("an oversized body is refused rather than stored", () => {
  assert.throws(() => normalizeDraftInput({ body: "x".repeat(1_000_001) }), DraftError);
});

// ---------------------------------------------------------------- lifecycle

test("create then read returns the same draft", async () => {
  const { drafts } = newDrafts();
  const { draft } = await drafts.create({ title: "First", body: "Hello", tags: ["meta"] });
  assert.match(draft.postId, /^p_[0-9a-f]{16}$/);
  assert.equal(draft.version, 1);

  const read = await drafts.get(draft.postId);
  assert.equal(read.draft.title, "First");
  assert.equal(read.draft.body, "Hello");
  assert.deepEqual(read.draft.tags, ["meta"]);
});

test("drafts survive a cold restart — nothing is held in memory", async () => {
  const client = createFakeS3();
  const first = createDraftStore(createStore({ config: FAKE_CONFIG, client }));
  const { draft } = await first.create({ title: "Persisted", body: "text" });

  // A completely new store over the same bucket, as after a function cold start.
  const second = createDraftStore(createStore({ config: FAKE_CONFIG, client }));
  const read = await second.get(draft.postId);
  assert.equal(read.draft.title, "Persisted");
});

test("saving bumps the version and preserves untouched fields", async () => {
  const { drafts } = newDrafts();
  const created = await drafts.create({ title: "Draft", body: "one", tags: ["a"] });
  const saved = await drafts.save(created.draft.postId, { body: "two" }, created.etag);

  assert.equal(saved.draft.version, 2);
  assert.equal(saved.draft.body, "two");
  assert.equal(saved.draft.title, "Draft", "an unrelated field was dropped on save");
  assert.deepEqual(saved.draft.tags, ["a"]);
  assert.equal(saved.draft.createdAt, created.draft.createdAt);
});

test("reading an unknown draft returns null, and saving one is an error", async () => {
  const { drafts } = newDrafts();
  assert.equal(await drafts.get("p_00000000000000ff"), null);
  await assert.rejects(
    () => drafts.save("p_00000000000000ff", { body: "x" }, '"etag"'),
    DraftError
  );
});

test("malformed post ids are refused before any storage call", async () => {
  const { drafts, client } = newDrafts();
  const before = client.callCount;
  await assert.rejects(() => drafts.get("../escape"), DraftError);
  await assert.rejects(() => drafts.get("not-a-post-id"), DraftError);
  assert.equal(client.callCount, before, "an invalid id reached the store");
});

// ------------------------------------------------- concurrency (Step 2 gate)

test("two tabs editing the same version: the second gets an explicit conflict", async () => {
  const { drafts } = newDrafts();
  const created = await drafts.create({ title: "Shared", body: "original" });

  const tabA = await drafts.get(created.draft.postId);
  const tabB = await drafts.get(created.draft.postId);

  await drafts.save(created.draft.postId, { body: "from A" }, tabA.etag);
  await assert.rejects(
    () => drafts.save(created.draft.postId, { body: "from B" }, tabB.etag),
    ConflictError,
    "tab B silently overwrote tab A"
  );

  const final = await drafts.get(created.draft.postId);
  assert.equal(final.draft.body, "from A");
});

test("save refuses to run without an ETag rather than clobbering", async () => {
  const { drafts } = newDrafts();
  const created = await drafts.create({ title: "T" });
  await assert.rejects(() => drafts.save(created.draft.postId, { body: "x" }), DraftError);
});

test("a lost pointer race leaves an orphan revision but never loses the draft", async () => {
  const { drafts, store } = newDrafts();
  const created = await drafts.create({ title: "T", body: "original" });
  const postId = created.draft.postId;

  const stale = await drafts.get(postId);
  await drafts.save(postId, { body: "winner" }, stale.etag);

  const revisionsBefore = await drafts.revisions(postId);
  await assert.rejects(() => drafts.save(postId, { body: "loser" }, stale.etag), ConflictError);

  // The loser's revision object exists and is collectable...
  const revisionsAfter = await drafts.revisions(postId);
  assert.equal(revisionsAfter.length, revisionsBefore.length + 1, "no orphan revision was written");

  // ...but the pointer, which is what anyone reads, still names the winner.
  const current = await drafts.get(postId);
  assert.equal(current.draft.body, "winner");
  const orphan = revisionsAfter.find((r) => !revisionsBefore.includes(r));
  const orphanRecord = await drafts.getRevision(postId, orphan);
  assert.equal(orphanRecord.body, "loser");
  assert.notEqual(current.draft.revisionId, orphan, "the orphan became the current draft");
});

// ---------------------------------------------------------------- revisions

test("every save leaves an immutable revision behind", async () => {
  const { drafts } = newDrafts();
  let { draft, etag } = await drafts.create({ title: "T", body: "v1" });
  for (const body of ["v2", "v3"]) {
    ({ draft, etag } = await drafts.save(draft.postId, { body }, etag));
  }
  const revisions = await drafts.revisions(draft.postId);
  assert.equal(revisions.length, 3);

  const bodies = [];
  for (const id of revisions) bodies.push((await drafts.getRevision(draft.postId, id)).body);
  assert.deepEqual(bodies, ["v1", "v2", "v3"], "revisions are not in chronological order");
});

test("revision ids sort by version as plain strings", () => {
  const ids = [newRevisionId(3), newRevisionId(1), newRevisionId(12), newRevisionId(2)];
  assert.deepEqual([...ids].sort(), [ids[1], ids[3], ids[0], ids[2]]);
});

test("revision ids stay ordered when saves land in the same millisecond", () => {
  // Debounced autosave does exactly this. An earlier timestamp-led id let the
  // random suffix decide the order here.
  const frozen = 1_700_000_000_000;
  const ids = Array.from({ length: 25 }, (_, i) => newRevisionId(i + 1, frozen));
  assert.deepEqual([...ids].sort(), ids, "same-millisecond revisions sorted out of order");
});

test("a revision id demands a real version rather than silently defaulting", () => {
  assert.throws(() => newRevisionId(), TypeError);
  assert.throws(() => newRevisionId(0), TypeError);
  assert.throws(() => newRevisionId("2"), TypeError);
});

// ---------------------------------------------------------------- listing

test("listing returns summaries without bodies, newest first", async () => {
  const { drafts } = newDrafts();
  let clock = 0;
  const stamped = createDraftStore(
    createStore({ config: FAKE_CONFIG, client: createFakeS3() }),
    { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString() }
  );
  await stamped.create({ title: "Older", body: "a".repeat(500) });
  await stamped.create({ title: "Newer", body: "b".repeat(500) });

  const list = await stamped.list();
  assert.deepEqual(list.map((d) => d.title), ["Newer", "Older"]);
  assert.ok(!("body" in list[0]), "the list shipped full post bodies");
  assert.ok(list[0].postId && list[0].updatedAt);

  assert.deepEqual(await drafts.list(), [], "an empty store should list nothing");
});

test("removing a draft takes its revisions with it", async () => {
  const { drafts } = newDrafts();
  const created = await drafts.create({ title: "Doomed", body: "v1" });
  await drafts.save(created.draft.postId, { body: "v2" }, created.etag);

  // Counts every object the post owned: the pointer plus both revisions.
  const removed = await drafts.remove(created.draft.postId);
  assert.equal(removed, 3);
  assert.equal(await drafts.get(created.draft.postId), null);
  assert.deepEqual(await drafts.revisions(created.draft.postId), []);
});
