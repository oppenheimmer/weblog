// Tier 3 — inventory and garbage collection.
//
// This is the code that deletes things, so the tests are weighted towards what
// must *survive*. A sweep that frees no bytes is a minor waste; a sweep that
// removes a published revision loses a post.
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createPublisher, INDEX_KEY, revisionKey } from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import {
  buildInventory, reachableKeys, collectGarbage, refreshInventory,
  formatTree, INVENTORY_KEY, RETENTION,
} from "../lib/server/inventory.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const DAY = 24 * 60 * 60 * 1000;

function harness() {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  return {
    store, client,
    drafts: createDraftStore(store),
    publisher: createPublisher(store, { fireDeployHook: async () => ({}) }),
  };
}

/** Backdate an object so age-based rules can be exercised without waiting. */
function backdate(client, keySuffix, ms) {
  for (const [key, value] of client.objects) {
    if (key.endsWith(keySuffix)) value.lastModified = new Date(Date.now() - ms);
  }
}

const complete = (over = {}) => ({
  postId: "p_00000000000000aa", revisionId: "r_000001_abc_1234", version: 1,
  title: "A post", date: "2026-07-01", description: "", tags: ["meta"],
  format: "markdown", body: "Body.", slug: "a-post", ...over,
});

// ---------------------------------------------------------------- the tree

test("the tree lists posts, their revisions and which one is current", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  await publisher.publish(complete({ revisionId: "r_000002_bbb_5678", body: "Revised." }));

  const tree = await buildInventory(store);
  assert.equal(tree.posts.length, 1);
  const post = tree.posts[0];
  assert.equal(post.slug, "a-post");
  assert.equal(post.state, "published");
  assert.equal(post.publishedRevisionId, "r_000002_bbb_5678");
  assert.equal(post.revisions.filter((r) => r.kind === "published").length, 2);
  assert.equal(post.revisions.filter((r) => r.current).length, 1);
});

test("drafts appear alongside published posts", async () => {
  const { store, drafts } = harness();
  await drafts.create({ title: "Just a draft", body: "text" });
  const tree = await buildInventory(store);
  assert.equal(tree.posts[0].state, "draft");
  assert.equal(tree.posts[0].title, "Just a draft");
  assert.ok(tree.posts[0].draftRevisionId);
});

test("the tree is derived, so it cannot drift from the bucket", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  await refreshInventory(store);

  // Change the world behind the inventory file's back.
  await publisher.unpublish("a-post");
  const rebuilt = await buildInventory(store);
  assert.notEqual(rebuilt.posts[0]?.state, "published",
    "the rebuilt tree repeated a stale claim instead of reading the bucket");
});

test("the tree renders as readable text", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  const text = formatTree(await buildInventory(store));
  assert.match(text, /a-post/);
  assert.match(text, /published revisions/);
});

// ------------------------------------------------------ what must survive

test("a current published revision is never collectable", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  backdate(client, ".json", 400 * DAY); // older than every retention window

  const swept = await collectGarbage(store, { apply: true });
  assert.ok(!swept.keys.includes(revisionKey("p_00000000000000aa", "r_000001_abc_1234")),
    "the live revision was deleted");
  const posts = await loadPublishedPosts({ store });
  assert.equal(posts.length, 1, "the post disappeared from the site");
});

test("the published index and inventory file are never collectable", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await refreshInventory(store);
  backdate(client, ".json", 400 * DAY);

  const swept = await collectGarbage(store, { apply: true });
  assert.ok(!swept.keys.includes(INDEX_KEY), "the published index was deleted");
  assert.ok(!swept.keys.includes(INVENTORY_KEY), "the inventory itself was deleted");
});

test("a draft's current revision and pointer survive", async () => {
  const { store, drafts, client } = harness();
  const { draft } = await drafts.create({ title: "Live draft", body: "text" });
  backdate(client, ".json", 400 * DAY);

  await collectGarbage(store, { apply: true });
  const found = await drafts.get(draft.postId);
  assert.ok(found, "an open draft was collected");
  assert.equal(found.draft.title, "Live draft");
});

test("nothing recent is ever swept, whatever the graph says", async () => {
  const { store, drafts } = harness();
  const created = await drafts.create({ title: "T", body: "v1" });
  let etag = created.etag;
  for (const body of ["v2", "v3"]) {
    ({ etag } = await drafts.save(created.draft.postId, { body }, etag));
  }
  // Superseded revisions exist, but everything was written moments ago: an
  // object seconds old may belong to a workflow still in flight.
  const swept = await collectGarbage(store, { apply: false });
  assert.equal(swept.deletable, 0, "a freshly written object was marked for deletion");
});

test("sessions and rate limits are left to their own expiry", async () => {
  const { store, client } = harness();
  await store.putJson("sessions/abc.json", { tokenHash: "abc" });
  await store.putJson("rate-limits/1000/client-x.json", { count: 1 });
  backdate(client, ".json", 400 * DAY);

  const swept = await collectGarbage(store, { apply: false });
  assert.ok(!swept.keys.some((k) => k.startsWith("sessions/")), "a session was swept");
  assert.ok(!swept.keys.some((k) => k.startsWith("rate-limits/")), "a rate-limit window was swept");
});

// ------------------------------------------------------ what gets collected

test("superseded published revisions survive the rollback window and go after it", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await publisher.publish(complete({ revisionId: "r_000002_bbb_5678", body: "Revised." }));
  const superseded = revisionKey("p_00000000000000aa", "r_000001_abc_1234");

  backdate(client, "r_000001_abc_1234.json", 30 * DAY);
  let keep = reachableKeys(await buildInventory(store));
  assert.ok(keep.has(superseded), "rollback was made impossible inside the window");

  backdate(client, "r_000001_abc_1234.json", 200 * DAY);
  keep = reachableKeys(await buildInventory(store));
  assert.ok(!keep.has(superseded), "a revision past the rollback window was kept forever");
});

test("old draft history is pruned but the post survives", async () => {
  const { store, drafts, client } = harness();
  const created = await drafts.create({ title: "T", body: "v1" });
  let etag = created.etag;
  for (let i = 2; i <= 30; i++) {
    ({ etag } = await drafts.save(created.draft.postId, { body: `v${i}` }, etag));
  }
  backdate(client, ".json", 90 * DAY);

  const swept = await collectGarbage(store, { apply: true });
  assert.ok(swept.deleted > 0, "30 draft revisions produced nothing to prune");

  const found = await drafts.get(created.draft.postId);
  assert.ok(found, "pruning history destroyed the draft");
  assert.equal(found.draft.body, "v30");
});

test("media belonging to a deleted post becomes collectable", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await store.put("published/media/a-post/diagram.png", Buffer.from("bytes"));

  let tree = await buildInventory(store);
  assert.equal(tree.posts[0].media.length, 1, "media was not attributed to its post");
  assert.ok(reachableKeys(tree).has("published/media/a-post/diagram.png"));

  await publisher.unpublish("a-post");
  backdate(client, "diagram.png", 400 * DAY);
  tree = await buildInventory(store);
  assert.equal(tree.orphanMedia.length, 1, "media of a removed post was not seen as orphaned");
  assert.ok(!reachableKeys(tree).has("published/media/a-post/diagram.png"));
});

test("abandoned uploads are collected after their window", async () => {
  const { store, client } = harness();
  await store.put("uploads/u_123/pending.png", Buffer.from("bytes"));

  backdate(client, "pending.png", 2 * 60 * 60 * 1000); // 2 hours: past minAge, inside 24h
  assert.ok(reachableKeys(await buildInventory(store)).has("uploads/u_123/pending.png"),
    "an upload was collected while still within its window");

  backdate(client, "pending.png", 3 * DAY);
  assert.ok(!reachableKeys(await buildInventory(store)).has("uploads/u_123/pending.png"));
});

// ---------------------------------------------------------------- safety

test("collection is dry by default", async () => {
  const { store, drafts, client } = harness();
  const created = await drafts.create({ title: "T", body: "v1" });
  let etag = created.etag;
  for (let i = 2; i <= 30; i++) {
    ({ etag } = await drafts.save(created.draft.postId, { body: `v${i}` }, etag));
  }
  backdate(client, ".json", 90 * DAY);

  const before = client.objects.size;
  const swept = await collectGarbage(store);
  assert.equal(swept.apply, false);
  assert.equal(swept.deleted, 0);
  assert.equal(client.objects.size, before, "a dry run deleted objects");
  assert.ok(swept.deletable > 0, "a dry run reported nothing to do");
});

test("a sweep is bounded, so one run cannot delete everything", async () => {
  const { store, drafts, client } = harness();
  const created = await drafts.create({ title: "T", body: "v1" });
  let etag = created.etag;
  for (let i = 2; i <= 40; i++) {
    ({ etag } = await drafts.save(created.draft.postId, { body: `v${i}` }, etag));
  }
  backdate(client, ".json", 90 * DAY);

  const swept = await collectGarbage(store, { apply: true, maxDeletions: 3 });
  assert.equal(swept.deleted, 3);
  assert.equal(swept.truncated, true);
});

test("housekeeping failure never propagates to the caller", async () => {
  const { store, publisher } = harness();
  // A store whose listing is broken would otherwise fail the sweep.
  const broken = { ...store, listAll: async () => { throw new Error("R2 unreachable"); } };
  const { onStateChange } = await import("../lib/server/inventory.mjs");
  const result = await onStateChange(broken);
  assert.equal(result.ok, false, "a broken sweep was reported as success");

  // And a real publish still succeeds and is readable.
  const job = await publisher.publish(complete());
  assert.equal(job.state, "building");
  assert.equal((await loadPublishedPosts({ store })).length, 1);
});

test("publishing refreshes the inventory automatically", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  const stored = await store.getJson(INVENTORY_KEY);
  assert.ok(stored, "no inventory was written after a publish");
  assert.equal(stored.data.posts[0].slug, "a-post");
});
