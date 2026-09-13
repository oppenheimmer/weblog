// Tier 3 — inventory and ownership-scoped collection.
//
// This is the code that deletes things, so the tests weight heavily towards
// what must *survive*. The headline property is the blast radius: deleting one
// post must be incapable of touching another, by construction rather than by
// care.
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createPublisher, INDEX_KEY, WRITE_LEASE_MS } from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { keys, classifyKey, ownedPrefixes, mediaUrl } from "../lib/server/keys.mjs";
import { computeRevisionId, validateManifest } from "../lib/interactives.mjs";
import { createInteractives } from "../lib/server/interactives.mjs";
import crypto from "node:crypto";
import {
  buildInventory, collectableForPost, collectGarbage, collectableJobs, deletePostObjects,
  refreshInventory, formatTree, RETENTION, INVENTORY_KEY,
} from "../lib/server/inventory.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const DAY = 24 * 60 * 60 * 1000;
const A = "p_00000000000000aa";
const B = "p_00000000000000bb";
const BUNDLE = "i_00000000000000c1";
const BUNDLE_REVISION = "iv_00000000000000d1";

/** Every key one interactive bundle occupies, private and published. */
function bundleKeys(postId) {
  return [
    keys.interactiveManifest(postId, BUNDLE, BUNDLE_REVISION),
    keys.interactiveFile(postId, BUNDLE, BUNDLE_REVISION, "index.html"),
    keys.interactiveFile(postId, BUNDLE, BUNDLE_REVISION, "lib/plot/draw.mjs"),
    keys.interactiveName(postId, "orbit"),
    keys.publishedInteractive(postId, BUNDLE, BUNDLE_REVISION, "index.html"),
  ];
}

/** Put a bundle's objects in the bucket, without the upload path that will write them. */
async function seedBundle(store, postId) {
  for (const key of bundleKeys(postId)) await store.put(key, Buffer.from("bundle"));
}

function harness() {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  return {
    store, client,
    drafts: createDraftStore(store),
    publisher: createPublisher(store, { fireDeployHook: async () => ({}) }),
  };
}

/** Backdate matching objects so age rules can run without waiting. */
function backdate(client, match, ms) {
  for (const [key, value] of client.objects) {
    if (key.includes(match)) value.lastModified = new Date(Date.now() - ms);
  }
}

const complete = (over = {}) => ({
  postId: A, revisionId: "r_000001_abc_1234", version: 1,
  title: "A post", date: "2026-07-01", description: "", tags: ["meta"],
  format: "markdown", body: "Body.", slug: "a-post", ...over,
});

// ---------------------------------------------------------------- ownership

test("every content key names its owning post", () => {
  const cases = [
    [keys.draftPointer(A), "draft-pointer"],
    [keys.draftRevision(A, "r_000001_x_1"), "draft-revision"],
    [keys.publishedRevision(A, "r_000001_x_1"), "published-revision"],
    [keys.media(A, "diagram.png"), "media"],
    [keys.upload(A, "u_1", "pending.png"), "upload"],
    // §3.6 makes this the precondition for enabling bundle uploads at all: an
    // object the collector cannot place is one it will never sweep.
    [keys.interactiveManifest(A, BUNDLE, BUNDLE_REVISION), "interactive-manifest"],
    [keys.interactiveFile(A, BUNDLE, BUNDLE_REVISION, "lib/draw.mjs"), "interactive-file"],
    [keys.interactiveName(A, "orbit"), "interactive-name"],
    [keys.publishedInteractive(A, BUNDLE, BUNDLE_REVISION, "index.html"), "published-interactive"],
  ];
  for (const [key, kind] of cases) {
    const info = classifyKey(key);
    assert.equal(info.kind, kind, key);
    assert.equal(info.owned, true, key);
    assert.equal(info.postId, A, `${key} did not name its owner`);
  }
});

test("shared records belong to no post and are never owned", () => {
  for (const key of [
    keys.publishedIndex, keys.inventory, keys.job("j_1"),
    keys.session("abc"), "rate-limits/1000/client-x.json",
  ]) {
    const info = classifyKey(key);
    assert.equal(info.owned, false, key);
    assert.equal(info.postId, null, key);
  }
});

test("an unrecognised key is reported, never claimed by a post", () => {
  const info = classifyKey("something/unexpected.bin");
  assert.equal(info.kind, "unknown");
  assert.equal(info.owned, false);
});

test("a bundle key carries the one level no other key has", () => {
  // Post, interactive, revision, then the file's own relative name — and the
  // name keeps its directory structure, because `index.html` refers to
  // `./lib/plot/draw.mjs` by that path and nothing may rewrite it (§3.6).
  const info = classifyKey(keys.interactiveFile(A, BUNDLE, BUNDLE_REVISION, "lib/plot/draw.mjs"));
  assert.equal(info.postId, A);
  assert.equal(info.id, BUNDLE);
  assert.equal(info.revisionId, BUNDLE_REVISION);
  assert.equal(info.name, "lib/plot/draw.mjs");

  // Every other kind reports no bundle revision, so a caller reading the field
  // cannot quietly be handed a draft revision id instead.
  assert.equal(classifyKey(keys.draftRevision(A, "r_000001_x_1")).revisionId, null);
  assert.equal(classifyKey(keys.media(A, "a.png")).revisionId, null);
});

test("a bundle's name claim is not mistaken for a bundle", () => {
  // `names` sits at the same level as an interactive id. It is told apart by
  // the id's shape, so a claim can never be read as a revision of something.
  const claim = classifyKey(keys.interactiveName(A, "orbit"));
  assert.equal(claim.kind, "interactive-name");
  assert.equal(claim.postId, A);
  assert.equal(claim.revisionId, null);
});

test("storage is keyed by post id while public URLs stay slug-based", () => {
  assert.match(keys.media(A, "diagram.png"), /published\/media\/p_00000000000000aa\/diagram\.png/);
  assert.equal(mediaUrl("a-post", "diagram.png"), "/images/uploads/a-post/diagram.png");
});

// ------------------------------------------------- the blast-radius property

test("deleting one post cannot touch another post's objects", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  await publisher.publish(complete({ postId: B, slug: "b-post", title: "B", revisionId: "r_000001_bbb_1" }));
  await store.put(keys.media(A, "a.png"), Buffer.from("a"));
  await store.put(keys.media(B, "b.png"), Buffer.from("b"));

  // Read through the store, which is what owns the environment prefix. Listing
  // the backing client directly returns prefixed keys, which classifyKey reads
  // as unknown — so an earlier version of this test compared two empty lists
  // and would have passed however badly deletion behaved.
  const ownedBy = async (postId) =>
    (await store.listAll("")).map(({ key }) => key).filter((key) => classifyKey(key).postId === postId);

  const before = await ownedBy(B);
  assert.ok(before.length > 0, "the fixture wrote nothing for post B, so nothing here is being tested");
  assert.ok((await ownedBy(A)).length > 0, "the fixture wrote nothing for post A");

  await deletePostObjects(store, A, { apply: true });

  assert.deepEqual((await ownedBy(B)).sort(), before.sort(), "deleting post A disturbed post B");
  assert.equal((await ownedBy(A)).length, 0, "post A's objects were not all removed");
});

test("a post deletion refuses to touch a key it does not own", async () => {
  const { store } = harness();
  // A store whose listing lies, returning another post's key.
  const lying = { ...store, listAll: async () => [{ key: keys.media(B, "stolen.png"), size: 1 }] };
  await assert.rejects(
    () => deletePostObjects(lying, A, { apply: true }),
    /refusing to delete keys not owned by p_00000000000000aa/
  );
});

test("collection for one post names only that post's keys", async () => {
  const { store, drafts, client } = harness();
  const first = await drafts.create({ title: "First", body: "v1" });
  const second = await drafts.create({ title: "Second", body: "v1" });
  let etag = first.etag;
  for (let i = 2; i <= 30; i++) {
    ({ etag } = await drafts.save(first.draft.postId, { body: `v${i}` }, etag));
  }
  backdate(client, "", 90 * DAY);

  const swept = await collectGarbage(store, { apply: false, postId: first.draft.postId });
  assert.ok(swept.deletable > 0);
  for (const key of swept.keys) {
    assert.equal(classifyKey(key).postId, first.draft.postId,
      `scoped collection named a foreign key: ${key}`);
  }
  assert.ok(!swept.keys.some((k) => k.includes(second.draft.postId)));
});

// --------------------------------------------------------------- bundles

test("deleting a post takes its interactive bundles with it", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await publisher.publish(complete({ postId: B, slug: "b-post", title: "B", revisionId: "r_000001_bbb_1" }));
  await seedBundle(store, A);
  await seedBundle(store, B);

  // Present first, so a sweep that deleted everything could not look like a
  // sweep that deleted exactly the right thing.
  for (const key of [...bundleKeys(A), ...bundleKeys(B)]) {
    assert.ok(await store.get(key), `the fixture never wrote ${key}`);
  }

  await deletePostObjects(store, A, { apply: true });

  for (const key of bundleKeys(A)) {
    assert.ok(!(await store.get(key)), `a bundle object outlived its post: ${key}`);
  }
  for (const key of bundleKeys(B)) {
    assert.ok(await store.get(key), `deleting post A took post B's bundle: ${key}`);
  }
});

test("a live post's bundle whose manifest cannot be read is never judged, whatever its age", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await seedBundle(store, A); // "bundle" is not a manifest anyone can read
  backdate(client, "", 400 * DAY);

  const swept = await collectGarbage(store, { apply: true });
  assert.deepEqual(swept.unknownKeys, [], "a bundle key was not recognised");
  // One unreadable fact and no bundle of the post is judged — its published
  // copy included, though no stored revision names it.
  for (const key of bundleKeys(A)) {
    assert.ok(await store.get(key), `a bundle was swept on facts that could not be read: ${key}`);
  }
});

// A lab uploaded and published through the real paths, so manifests are genuine
// and published revisions really name the bundle revisions they use.
async function labPost(h) {
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  const interactives = createInteractives(h.store, { signPut: async (key) => key });
  const publisher = createPublisher(h.store, {
    interactives, fireDeployHook: async () => ({}), housekeep: async () => ({ ok: true }),
  });
  const { draft } = await h.drafts.create({ title: "Lab post", date: "2026-07-01", body: "seed", slug: "lab-post" });
  const postId = draft.postId;
  let interactiveId;
  const upload = async (demo) => {
    const files = { "index.html": "<!doctype html><title>lab</title>", "fallback.html": "<p>still</p>", "demo.mjs": demo };
    const agreed = await interactives.begin({
      postId, interactiveId,
      manifest: {
        kind: "demo", name: "orbit", entry: "index.html", fallback: "fallback.html",
        files: Object.entries(files).map(([name, body]) => ({ name, bytes: Buffer.byteLength(body), sha256: sha(body) })),
      },
    });
    for (const [name, body] of Object.entries(files)) {
      await h.store.put(keys.upload(postId, agreed.uploadId, `files/${name}`), Buffer.from(body));
    }
    const record = await interactives.complete({ postId, uploadId: agreed.uploadId });
    interactiveId = record.id;
    return record;
  };
  const publishWith = async (body) => {
    const current = await h.drafts.get(postId);
    const saved = await h.drafts.save(postId, { body }, current.etag);
    await publisher.publish(saved.draft);
    return saved.draft;
  };
  return { postId, upload, publishWith, publisher, interactives, interactiveId: () => interactiveId };
}

const bundleObjects = async (store, postId, revisionId) => [
  ...await store.listAll(`interactives/${postId}/`),
  ...await store.listAll(`published/interactives/${postId}/`),
].map((o) => o.key).filter((key) => key.includes(`/${revisionId}/`));

test("an interactive keeps its three most recent revisions, however old", async () => {
  const h = harness();
  const lab = await labPost(h);
  const v1 = await lab.upload("export const v = 1;\n");
  await lab.upload("export const v = 2;\n");
  const v3 = await lab.upload("export const v = 3;\n");
  backdate(h.client, "", 400 * DAY);

  await collectGarbage(h.store, { apply: true });
  for (const revision of [v1, v3]) {
    assert.ok(await h.store.get(keys.interactiveManifest(lab.postId, revision.id, revision.revisionId)),
      `revision ${revision.revisionId} of three was collected`);
  }
});

test("a fourth revision pushes the least recently current out, and the live post still builds", async () => {
  const h = harness();
  const lab = await labPost(h);
  const v1 = await lab.upload("export const v = 1;\n");
  const first = await lab.publishWith(`::demo[${v1.id}]`);
  await lab.upload("export const v = 2;\n");
  await lab.upload("export const v = 3;\n");
  const v4 = await lab.upload("export const v = 4;\n");
  await lab.publishWith(`::demo[${v1.id}]\n\nNew words.`);
  backdate(h.client, "", 2 * RETENTION.minAgeMs);

  const before = await bundleObjects(h.store, lab.postId, v1.revisionId);
  assert.ok(before.some((key) => key.startsWith("interactives/")), "the first revision was never stored, so nothing was tested");
  const swept = await collectGarbage(h.store, { apply: true });
  const v1Keys = swept.keys.filter((key) => key.includes(v1.revisionId));
  assert.match(v1Keys[0] ?? "", /manifest\.json$/, "files were deleted before the manifest that commits them");
  assert.ok(!(await h.store.get(keys.interactiveManifest(lab.postId, v1.id, v1.revisionId))), "a fourth revision was kept");
  // Its published copy stays while a stored published revision names it, for
  // a rollback, which publishes from that copy.
  assert.ok((await bundleObjects(h.store, lab.postId, v1.revisionId)).every((key) => key.startsWith("published/")));
  assert.ok((await bundleObjects(h.store, lab.postId, v1.revisionId)).length > 0, "a named published copy was collected");
  await h.publisher.rollback(lab.postId, first.revisionId);
  assert.equal((await loadPublishedPosts({ store: h.store }))[0].interactives[0].revisionId, v1.revisionId);

  // Once the published revision naming it leaves its window, the copy goes.
  backdate(h.client, "", 100 * DAY);
  await h.publisher.rollback(lab.postId, (await h.publisher.listPublications())[0].revisions[0].revisionId);
  backdate(h.client, "", 100 * DAY);
  await collectGarbage(h.store, { apply: true }); // the old published revision goes
  await collectGarbage(h.store, { apply: true }); // then nothing names v1's copy
  assert.deepEqual(await bundleObjects(h.store, lab.postId, v1.revisionId), [], "an unnamed published copy stayed");
  assert.ok(await h.store.get(keys.interactiveName(lab.postId, "orbit")), "the name claim was collected");
  const posts = await loadPublishedPosts({ store: h.store });
  assert.equal(posts[0].interactives[0].revisionId, v4.revisionId, "the live post lost its bundle");
});

test("putting a revision back makes it recent, so newer uploads push others out first", async () => {
  const h = harness();
  const lab = await labPost(h);
  const v1 = await lab.upload("export const v = 1;\n");
  const v2 = await lab.upload("export const v = 2;\n");
  await lab.upload("export const v = 3;\n");
  await lab.interactives.promote({ postId: lab.postId, interactiveId: v1.id, revisionId: v1.revisionId });
  await lab.upload("export const v = 4;\n");
  backdate(h.client, "", 2 * RETENTION.minAgeMs);

  await collectGarbage(h.store, { apply: true });
  assert.ok(await h.store.get(keys.interactiveManifest(lab.postId, v1.id, v1.revisionId)), "a revision put back was collected");
  assert.ok(!(await h.store.get(keys.interactiveManifest(lab.postId, v2.id, v2.revisionId))),
    "the least recently current revision was kept");
});

test("no revision is collected inside the age floor, even a fourth", async () => {
  const h = harness();
  const lab = await labPost(h);
  const v1 = await lab.upload("export const v = 1;\n");
  for (const n of [2, 3, 4]) await lab.upload(`export const v = ${n};\n`);
  backdate(h.client, "", RETENTION.minAgeMs / 2);

  await collectGarbage(h.store, { apply: true });
  assert.ok(await h.store.get(keys.interactiveManifest(lab.postId, v1.id, v1.revisionId)), "collected inside the age floor");
});

test("a stored revision that vanishes between listing and reading keeps every published bundle copy", async () => {
  const h = harness();
  const lab = await labPost(h);
  const v1 = await lab.upload("export const v = 1;\n");
  const first = await lab.publishWith(`::demo[${v1.id}]`);
  await h.store.put(keys.publishedInteractive(lab.postId, v1.id, "iv_00000000000000ee", "index.html"), Buffer.from("stray"));
  backdate(h.client, "", 400 * DAY);
  // Listed, then gone by the time it is read: what another sweep in flight
  // looks like from here.
  const vanished = keys.publishedRevision(lab.postId, first.revisionId);
  const read = h.store.getJson;
  h.store.getJson = (key) => (key === vanished ? Promise.resolve(null) : read(key));

  await collectGarbage(h.store, { apply: true });
  assert.ok(await h.client.objects.get(`${FAKE_CONFIG.prefix}/${keys.publishedInteractive(lab.postId, v1.id, "iv_00000000000000ee", "index.html")}`),
    "an unnamed copy was collected though a listed revision could not be read");
});

test("a stored revision that cannot be read keeps every published bundle copy", async () => {
  const h = harness();
  const lab = await labPost(h);
  const v1 = await lab.upload("export const v = 1;\n");
  const first = await lab.publishWith(`::demo[${v1.id}]`);
  await h.store.put(keys.publishedInteractive(lab.postId, v1.id, "iv_00000000000000ee", "index.html"), Buffer.from("stray"));
  await h.store.put(keys.publishedRevision(lab.postId, "r_000001_0000_broken"), Buffer.from("{ not json"));
  backdate(h.client, "", 400 * DAY);

  await collectGarbage(h.store, { apply: true }).catch(() => {});
  assert.ok(await h.store.get(keys.publishedInteractive(lab.postId, v1.id, "iv_00000000000000ee", "index.html")),
    "an unnamed copy was collected though a revision could not be read");
  assert.ok(first);
});

test("an orphaned post's bundles are swept with the rest of it", async () => {
  const { store, drafts, client } = harness();
  const { draft } = await drafts.create({ title: "Gone", body: "text" });
  await seedBundle(store, draft.postId);
  // Discard the draft, leaving the post owning objects nothing references.
  for (const key of [keys.draftPointer(draft.postId), keys.draftRevision(draft.postId, draft.revisionId)]) {
    await store.delete(key);
  }
  backdate(client, "", 400 * DAY);

  for (const key of bundleKeys(draft.postId)) {
    assert.ok(await store.get(key), `the fixture never wrote ${key}`);
  }

  const swept = await collectGarbage(store, { apply: true });
  for (const key of bundleKeys(draft.postId)) {
    assert.ok(!(await store.get(key)), `an orphan's bundle survived collection: ${key}`);
  }
  assert.ok(swept.deleted >= bundleKeys(draft.postId).length);
});

test("the inventory counts a bundle's bytes against its post", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  const before = (await buildInventory(store)).posts.find((p) => p.postId === A);
  await seedBundle(store, A);
  const after = (await buildInventory(store)).posts.find((p) => p.postId === A);

  assert.equal(after.interactives.length, bundleKeys(A).length);
  assert.ok(after.bytes > before.bytes, "bundle bytes were not counted");
  assert.match(formatTree(await buildInventory(store)), /interactive bundles \(1\)/);
});

test("a bundle revision is named by its contents, so the key cannot drift", () => {
  // The id in the key is the same id the contract derives from the manifest.
  // If these ever disagreed, a published post would name a revision that was
  // stored under a different key.
  const manifest = validateManifest({
    kind: "demo", postId: A, name: "orbit", entry: "index.html", fallback: "fallback.html",
    files: [
      { name: "index.html", bytes: 1, sha256: "a".repeat(64) },
      { name: "fallback.html", bytes: 1, sha256: "b".repeat(64) },
    ],
  });
  const revisionId = computeRevisionId(manifest);
  const key = keys.interactiveManifest(A, BUNDLE, revisionId);
  assert.equal(classifyKey(key).revisionId, revisionId);
  assert.equal(classifyKey(key).kind, "interactive-manifest");
});

// ------------------------------------------------------------------- jobs

test("a job is kept while the index still names its revision", async () => {
  // The publisher answers a repeated publish with the stored job only while the
  // index still names that revision at that slug. Collection reads the same
  // rule the other way round, so the two cannot disagree about when a job
  // still matters.
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  backdate(client, "publications/", 400 * DAY);

  const tree = await buildInventory(store);
  assert.equal(tree.jobs.length, 1, "the inventory does not see publication jobs");
  assert.deepEqual(await collectableJobs(store, tree), [], "a live post's job was collected");

  const swept = await collectGarbage(store, { apply: true });
  assert.ok(!swept.keys.some((key) => key.startsWith("publications/")),
    "a job answering for the published revision was swept");
});

test("a job outlives its retention window only once it can answer for nothing", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  // Off the site: the index no longer names the revision, so no repeat can be
  // answered by this job.
  await publisher.unpublish(A);
  backdate(client, "publications/", 400 * DAY);

  const tree = await buildInventory(store);
  const doomed = await collectableJobs(store, tree);
  assert.equal(doomed.length, 1, "an unanswerable job was kept for ever");

  const swept = await collectGarbage(store, { apply: true });
  assert.ok(swept.keys.some((key) => key.startsWith("publications/")));
  assert.deepEqual(
    (await store.listAll("publications/")).map(({ key }) => key), [],
    "the job survived a sweep that named it"
  );
});

test("a job inside its window is kept even when it can answer for nothing", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await publisher.unpublish(A);
  // Old enough to be swept at all, far short of the job window.
  backdate(client, "publications/", 2 * DAY);

  const tree = await buildInventory(store);
  assert.deepEqual(await collectableJobs(store, tree), [],
    "a recent job was collected; a finished job is the record of what happened");
  assert.ok(RETENTION.publicationJobMs > 2 * DAY);
});

test("discarding a post deletes its publication jobs, and no other post's", async () => {
  // A job id is derived from post and revision rather than nested under either,
  // so deleting a post's prefixes cannot reach one. Found on production: a
  // discarded post's job was the one object left naming it.
  const { store, publisher, drafts } = harness();
  const gone = await drafts.create({ title: "Gone", body: "text" });
  const kept = await drafts.create({ title: "Kept", body: "text" });
  await publisher.publish(complete({ postId: gone.draft.postId, slug: "gone" }));
  await publisher.publish(complete({ postId: kept.draft.postId, slug: "kept" }));
  await publisher.unpublish(gone.draft.postId);
  await publisher.unpublish(kept.draft.postId);
  assert.equal((await store.listAll("publications/")).length, 2, "the fixture has no jobs to discard");

  await drafts.remove(gone.draft.postId);
  const left = await Promise.all((await store.listAll("publications/")).map(async ({ key }) =>
    (await store.getJson(key)).data.postId));
  assert.deepEqual(left, [kept.draft.postId]);
  assert.ok(!(await store.listAll("")).some(({ key }) => key.includes(gone.draft.postId)),
    "something naming the discarded post survived its discard");
});

test("a job whose post is gone goes after the age floor, not the job window", async () => {
  // A discard interrupted between deleting the post and its jobs, or one from
  // before discard deleted jobs at all: the post no longer exists, so its job
  // records nothing anyone can return to.
  const { store, publisher, drafts, client } = harness();
  const created = await drafts.create({ title: "A post", body: "text" });
  await publisher.publish(complete({ postId: created.draft.postId, slug: "gone" }));
  await publisher.unpublish(created.draft.postId);
  await deletePostObjects(store, created.draft.postId, { apply: true });
  assert.equal((await store.listAll("publications/")).length, 1,
    "deleting a post's prefixes reached a shared record, which scoping forbids");

  backdate(client, "publications/", RETENTION.minAgeMs / 2);
  await collectGarbage(store, { apply: true });
  assert.equal((await store.listAll("publications/")).length, 1, "a job younger than the age floor was swept");

  backdate(client, "publications/", RETENTION.minAgeMs + 60_000);
  await collectGarbage(store, { apply: true });
  assert.deepEqual((await store.listAll("publications/")).map(({ key }) => key), []);
});

test("a scoped sweep never names a job", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await publisher.unpublish(A);
  backdate(client, "", 400 * DAY);

  const swept = await collectGarbage(store, { apply: false, postId: A });
  assert.ok(!swept.keys.some((key) => key.startsWith("publications/")),
    "a post-scoped sweep reached beyond that post");
});

// ------------------------------------------------------ what must survive

test("a current published revision is never collectable", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  backdate(client, "", 400 * DAY); // older than every window

  await collectGarbage(store, { apply: true });
  const posts = await loadPublishedPosts({ store });
  assert.equal(posts.length, 1, "the live post disappeared");
});

test("shared records are never collectable", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await refreshInventory(store);
  await store.putJson(keys.session("abc"), { tokenHash: "abc" });
  await store.putJson("rate-limits/1000/client-x.json", { count: 1 });
  backdate(client, "", 400 * DAY);

  const swept = await collectGarbage(store, { apply: true });
  for (const key of [INDEX_KEY, INVENTORY_KEY, keys.session("abc")]) {
    assert.ok(!swept.keys.includes(key), `${key} was collected`);
  }
  assert.ok(await store.getJson(keys.session("abc")), "a live session was swept, signing the owner out");
});

test("an open draft survives any age", async () => {
  const { store, drafts, client } = harness();
  const { draft } = await drafts.create({ title: "Live draft", body: "text" });
  backdate(client, "", 400 * DAY);

  await collectGarbage(store, { apply: true });
  const found = await drafts.get(draft.postId);
  assert.ok(found, "an open draft was collected");
  assert.equal(found.draft.title, "Live draft");
});

test("nothing recent is swept, whatever the rules say", async () => {
  const { store, drafts } = harness();
  const created = await drafts.create({ title: "T", body: "v1" });
  let etag = created.etag;
  for (const body of ["v2", "v3"]) {
    ({ etag } = await drafts.save(created.draft.postId, { body }, etag));
  }
  const swept = await collectGarbage(store, { apply: false });
  assert.equal(swept.deletable, 0, "a freshly written object was marked for deletion");
});

test("unrecognised keys are reported but never deleted", async () => {
  const { store, client } = harness();
  await store.put("something/unexpected.bin", Buffer.from("x"));
  backdate(client, "", 400 * DAY);

  const swept = await collectGarbage(store, { apply: true });
  assert.ok(swept.unknownKeys.includes("something/unexpected.bin"));
  assert.ok(!swept.keys.includes("something/unexpected.bin"), "an unrecognised key was deleted");
  assert.ok(await store.get("something/unexpected.bin"), "the object is gone");
});

// ------------------------------------------------------ what gets collected

test("a post nothing references any more is collectable in full", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await store.put(keys.media(A, "diagram.png"), Buffer.from("bytes"));
  await publisher.unpublish(A);
  backdate(client, "", 400 * DAY);

  const tree = await buildInventory(store);
  assert.deepEqual(tree.orphanPostIds, [A], "the unreferenced post was not seen as orphaned");
  const doomed = collectableForPost(tree.posts[0]);
  assert.ok(doomed.some((d) => d.key === keys.media(A, "diagram.png")), "its media was kept");
});

test("a post unpublished without a draft stays whole while it can still be put back", async () => {
  // A post migrated from the repository has no draft, so once unpublished
  // nothing references it. Without this it went an hour later, rollback window
  // or not.
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await store.put(keys.media(A, "diagram.png"), Buffer.from("bytes"));
  await publisher.unpublish(A);
  backdate(client, "", 30 * DAY);

  const tree = await buildInventory(store);
  assert.deepEqual(tree.orphanPostIds, [A]);
  assert.deepEqual(collectableForPost(tree.posts[0]), [], "a post inside its rollback window was marked collectable");
});

test("superseded revisions survive the rollback window and go after it", async () => {
  const { store, publisher, client } = harness();
  await publisher.publish(complete());
  await publisher.publish(complete({ revisionId: "r_000002_bbb_5678", body: "Revised." }));
  const superseded = keys.publishedRevision(A, "r_000001_abc_1234");

  backdate(client, "r_000001_abc_1234", 30 * DAY);
  let tree = await buildInventory(store);
  let doomed = collectableForPost(tree.posts[0]).map((d) => d.key);
  assert.ok(!doomed.includes(superseded), "rollback was made impossible inside the window");

  backdate(client, "r_000001_abc_1234", 200 * DAY);
  tree = await buildInventory(store);
  doomed = collectableForPost(tree.posts[0]).map((d) => d.key);
  assert.ok(doomed.includes(superseded), "a revision past the rollback window was kept forever");
});

test("old draft history is pruned but the draft survives", async () => {
  const { store, drafts, client } = harness();
  const created = await drafts.create({ title: "T", body: "v1" });
  let etag = created.etag;
  for (let i = 2; i <= 30; i++) {
    ({ etag } = await drafts.save(created.draft.postId, { body: `v${i}` }, etag));
  }
  backdate(client, "", 90 * DAY);

  const swept = await collectGarbage(store, { apply: true });
  assert.ok(swept.deleted > 0, "30 revisions produced nothing to prune");

  const found = await drafts.get(created.draft.postId);
  assert.ok(found, "pruning history destroyed the draft");
  assert.equal(found.draft.body, "v30");
});

test("abandoned uploads go after their window, not before", async () => {
  const { store, drafts, client } = harness();
  const { draft } = await drafts.create({ title: "T", body: "x" });
  await store.put(keys.upload(draft.postId, "u_1", "pending.png"), Buffer.from("bytes"));

  backdate(client, "pending.png", 2 * 60 * 60 * 1000); // past minAge, inside 24h
  let tree = await buildInventory(store);
  let post = tree.posts.find((p) => p.postId === draft.postId);
  assert.ok(!collectableForPost(post).some((d) => d.name === "pending.png"),
    "an upload was collected while still within its window");

  backdate(client, "pending.png", 3 * DAY);
  tree = await buildInventory(store);
  post = tree.posts.find((p) => p.postId === draft.postId);
  assert.ok(collectableForPost(post).some((d) => d.name === "pending.png"));
});

// ---------------------------------------------------------------- safety

test("collection is dry by default", async () => {
  const { store, drafts, client } = harness();
  const created = await drafts.create({ title: "T", body: "v1" });
  let etag = created.etag;
  for (let i = 2; i <= 30; i++) {
    ({ etag } = await drafts.save(created.draft.postId, { body: `v${i}` }, etag));
  }
  backdate(client, "", 90 * DAY);

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
  backdate(client, "", 90 * DAY);

  const swept = await collectGarbage(store, { apply: true, maxDeletions: 3 });
  assert.equal(swept.deleted, 3);
  assert.equal(swept.truncated, true);
});

test("housekeeping failure never propagates to the caller", async () => {
  const { store, publisher } = harness();
  const broken = { ...store, listAll: async () => { throw new Error("R2 unreachable"); } };
  const { onStateChange } = await import("../lib/server/inventory.mjs");
  assert.equal((await onStateChange(broken)).ok, false, "a broken sweep reported success");

  const job = await publisher.publish(complete());
  assert.equal(job.state, "building");
  assert.equal((await loadPublishedPosts({ store })).length, 1);
});

// ---------------------------------------------------------------- the tree

test("the tree lists posts, revisions and which one is current", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  await publisher.publish(complete({ revisionId: "r_000002_bbb_5678", body: "Revised." }));

  const tree = await buildInventory(store);
  const post = tree.posts[0];
  assert.equal(post.slug, "a-post");
  assert.equal(post.state, "published");
  assert.equal(post.publishedRevisionId, "r_000002_bbb_5678");
  assert.equal(post.revisions.filter((r) => r.current).length, 1);
});

test("the tree is derived, so it cannot repeat a stale claim", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  await refreshInventory(store);
  await publisher.unpublish(A);

  const rebuilt = await buildInventory(store);
  assert.notEqual(rebuilt.posts[0]?.state, "published",
    "the rebuilt tree trusted the stored file instead of the bucket");
});

test("publishing refreshes the inventory automatically", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  const stored = await store.getJson(INVENTORY_KEY);
  assert.equal(stored?.data.posts[0].slug, "a-post");
});

test("the tree renders as readable text", async () => {
  const { store, publisher } = harness();
  await publisher.publish(complete());
  const text = formatTree(await buildInventory(store));
  assert.match(text, /a-post/);
  assert.match(text, /published revisions/);
});

test("ownedPrefixes covers every place a post can have objects", () => {
  const prefixes = ownedPrefixes(A);
  for (const key of [
    keys.draftPointer(A), keys.draftRevision(A, "r_1"),
    keys.publishedRevision(A, "r_1"), keys.media(A, "x.png"), keys.upload(A, "u", "x.png"),
  ]) {
    assert.ok(prefixes.some((p) => key.startsWith(p)), `${key} is not under any owned prefix`);
  }
});

// ---------------------------------------------------------------- attachments
//
// Attachments added three key kinds under attachments/<postId>/. They must be
// owned like everything else, or post deletion refuses to run (it rejects any
// key it cannot attribute) and the sweep can never reclaim them.

import nodeFs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath as toFilePath } from "node:url";
import { createUploads } from "../lib/server/uploads.mjs";

const ATTACH_PNG = nodeFs.readFileSync(
  nodePath.join(nodePath.dirname(toFilePath(import.meta.url)), "fixtures", "media", "sample-7x11.png")
);

async function attachTo(store, postId, name = "diagram.png") {
  const uploads = createUploads(store, { signPut: async (key) => `https://signed.test/${key}` });
  const signed = await uploads.sign({ postId, name, size: ATTACH_PNG.length, type: "image/png" });
  await store.put(keys.upload(postId, signed.uploadId, "file"), ATTACH_PNG);
  return uploads.complete({ postId, uploadId: signed.uploadId });
}

test("deleting a post removes its attachments and cannot touch another post's", async () => {
  const { store, client, drafts } = harness();
  const { draft: first } = await drafts.create({ title: "First" });
  const { draft: second } = await drafts.create({ title: "Second" });
  await attachTo(store, first.postId);
  await attachTo(store, second.postId);

  const ownedBy = (postId) => [...client.objects.keys()].filter((k) => k.includes(`/attachments/${postId}/`));
  const before = ownedBy(second.postId).sort();
  assert.ok(before.length >= 3, "expected a record, a file and a name claim");

  await deletePostObjects(store, first.postId, { apply: true });
  assert.deepEqual(ownedBy(first.postId), [], "the deleted post's attachments survived");
  assert.deepEqual(ownedBy(second.postId).sort(), before, "deleting one post disturbed another's attachments");
});

test("an orphaned post's attachments are collectable, a live post's are not", async () => {
  const { store, client, drafts } = harness();
  const { draft: live } = await drafts.create({ title: "Live" });
  const { draft: gone } = await drafts.create({ title: "Gone" });
  await attachTo(store, live.postId);
  await attachTo(store, gone.postId);
  await store.delete(keys.draftPointer(gone.postId)); // nothing references it any more
  backdate(client, "", 400 * DAY);

  const tree = await buildInventory(store);
  const liveRecord = tree.posts.find((p) => p.postId === live.postId);
  const goneRecord = tree.posts.find((p) => p.postId === gone.postId);
  assert.ok(liveRecord.attachments.length >= 3);

  assert.ok(!collectableForPost(liveRecord).some((d) => d.key.startsWith("attachments/")),
    "a live post's attachment was marked collectable");
  const doomed = collectableForPost(goneRecord).map((d) => d.key);
  assert.ok(doomed.some((k) => k.startsWith(`attachments/${gone.postId}/files/`)), "an orphan's file was kept");
});

test("ownedPrefixes covers attachment keys too", () => {
  const prefixes = ownedPrefixes(A);
  for (const key of [
    keys.attachmentRecord(A, "a_00000000000000a1"),
    keys.attachmentBlob(A, "diagram.png"),
    keys.attachmentName(A, "diagram.png"),
    keys.uploadIntent(A, "u_00000000000000a1"),
  ]) {
    assert.ok(prefixes.some((p) => key.startsWith(p)), `${key} is not under any owned prefix`);
  }
});

// ------------------------------------------------ a sweep racing a publish

/**
 * A store that lets the test stop one call mid-flight.
 *
 * The sweep runs with `apply: true` after every publish, unpublish and
 * discard, so "a collection running while a publish is between its writes" is
 * not a hypothetical: it is the ordinary state of this system under two
 * overlapping actions. What protects the in-flight publish is the age floor —
 * nothing younger than an hour is swept — and that guard has never been
 * measured against an actual interleaving.
 */
function pausableStore(store, { on, hold }) {
  return {
    ...store,
    async mutateJson(key, ...rest) {
      if (key === on) await hold();
      return store.mutateJson(key, ...rest);
    },
  };
}

test("a sweep running mid-publish cannot delete what the publish is writing", async () => {
  const { store, client } = harness();
  const drafts = createDraftStore(store);
  const created = await drafts.create({ title: "Racing", body: "text", slug: "racing" });
  const postId = created.draft.postId;

  // The worst case for the age floor: a post with no draft pointer looks
  // orphaned, so its whole prefix is collectable on state alone. Only the
  // floor keeps an in-flight publish's objects.
  await store.delete(keys.draftPointer(postId));

  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  let sweptDuringPublish = null;

  const racing = createPublisher(
    pausableStore(store, { on: INDEX_KEY, hold: () => paused }),
    { fireDeployHook: async () => ({}), housekeep: async () => ({ ok: true, swept: { deleted: 0, bytesFreed: 0 } }) }
  );

  const publishing = racing.publish(complete({
    postId, slug: "racing", revisionId: created.draft.revisionId, title: "Racing",
  }));

  // The publish is now holding at its commit point, with its revision already
  // written. Sweep the whole bucket for real, then let it finish.
  sweptDuringPublish = await collectGarbage(store, { apply: true });
  release();
  const job = await publishing;

  // writing -> published -> building (Step 7): `building` is what a publish
  // that got past its commit point and fired the hook looks like.
  assert.ok(["published", "building"].includes(job.state),
    `the publish did not survive a concurrent sweep: ${job.state} ${job.error ?? ""}`);
  assert.deepEqual(sweptDuringPublish.keys, [],
    `a sweep deleted objects belonging to a publish in flight: ${sweptDuringPublish.keys.join(", ")}`);

  const posts = await loadPublishedPosts({ store });
  assert.deepEqual(posts.map((p) => p.slug), ["racing"]);
  assert.ok(await store.getJson(keys.publishedRevision(postId, created.draft.revisionId)),
    "the revision the index now names was swept from under it");

  // And the guard that did it is the age floor, not luck: age everything past
  // the floor and the same sweep empties the same post.
  backdate(client, "", 400 * DAY);
  await store.mutateJson(INDEX_KEY, (index) => ({ ...index, posts: {} }));
  const after = await collectGarbage(store, { apply: false });
  assert.ok(after.deletable > 0, "the sweep was never capable of deleting these objects");
});

test("the age floor is longer than the lease a publish may resume after", async () => {
  // The floor is not an arbitrary hour. A publish interrupted past its media
  // writes is resumed by the next Publish of that revision once its ten-minute
  // lease has passed (Step 6), so between those two moments its objects are
  // *already older than the lease* and still in flight. A floor shorter than
  // the lease would let a sweep delete them in exactly that window.
  assert.ok(RETENTION.minAgeMs > WRITE_LEASE_MS,
    `the sweep floor (${RETENTION.minAgeMs} ms) is not longer than the publish lease (${WRITE_LEASE_MS} ms)`);

  const { store, client } = harness();
  const drafts = createDraftStore(store);
  const created = await drafts.create({ title: "Resumed", body: "text", slug: "resumed" });
  const postId = created.draft.postId;
  await store.delete(keys.draftPointer(postId));

  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const racing = createPublisher(
    pausableStore(store, { on: INDEX_KEY, hold: () => paused }),
    { fireDeployHook: async () => ({}), housekeep: async () => ({ ok: true, swept: { deleted: 0, bytesFreed: 0 } }) }
  );
  const publishing = racing.publish(complete({
    postId, slug: "resumed", revisionId: created.draft.revisionId, title: "Resumed",
  }));

  // Age what the publish has already written past the lease, which is what a
  // resumed publish looks like from the outside, and sweep.
  backdate(client, "", WRITE_LEASE_MS + 60_000);
  const swept = await collectGarbage(store, { apply: true });
  release();
  await publishing;

  assert.deepEqual(swept.keys, [],
    `a sweep deleted a resumed publish's objects: ${swept.keys.join(", ")}`);
  assert.ok(await store.getJson(keys.publishedRevision(postId, created.draft.revisionId)),
    "the revision a resumed publish had already written was swept");
});
