// Exercises the publish path against the REAL bucket (CLAUDE.md Step 6).
//
//   node --env-file=.env scripts/verify-publish.mjs
//
// Runs under a throwaway prefix and cleans up, so it never touches published
// content. The deploy hook is stubbed by default — firing the real one would
// rebuild production for a test. Pass --fire-hook to exercise it for real.
import crypto from "node:crypto";
import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createPublisher, PublishError, INDEX_KEY } from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { buildInventory, collectGarbage, collectableForPost, INVENTORY_KEY } from "../lib/server/inventory.mjs";
import { loadR2Config } from "../lib/server/config.mjs";

const fireForReal = process.argv.includes("--fire-hook");

const config = { ...loadR2Config(), prefix: `probe-pub-${crypto.randomBytes(4).toString("hex")}` };
const store = createStore({ config });
const drafts = createDraftStore(store);

const hookCalls = [];
const publisher = createPublisher(store, {
  fireDeployHook: async () => {
    hookCalls.push(new Date().toISOString());
    if (!fireForReal) return { stubbed: true };
    const { defaultDeployHook } = await import("../lib/server/publish.mjs");
    return defaultDeployHook();
  },
});

const results = [];
const assert = (cond, message) => { if (!cond) throw new Error(message); };

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err?.message });
    console.log(` FAIL  ${name} — ${err?.message}`);
  }
}

console.log(`Publishing against real R2 under ${config.prefix}/`);
console.log(`Deploy hook: ${fireForReal ? "REAL (will rebuild production)" : "stubbed"}\n`);

let published;

await check("a draft written through the API publishes", async () => {
  const { draft } = await drafts.create({
    title: "Probe post", date: "2026-09-11", description: "Written by verify-publish.",
    tags: ["probe"], format: "markdown",
    body: "Body with inline math $E = mc^2$ and a [link](https://example.com).",
  });
  published = draft;
  const job = await publisher.publish(draft);
  assert(job.state === "building" || job.state === "published", `unexpected state ${job.state}`);
  assert(job.slug === "probe-post", `unexpected slug ${job.slug}`);
  assert(hookCalls.length === 1, `expected 1 hook call, got ${hookCalls.length}`);
});

await check("it appears in the published index", async () => {
  const index = await store.getJson(INDEX_KEY);
  assert(index?.data.posts["probe-post"], "not indexed");
  assert(index.data.posts["probe-post"].postId === published.postId, "wrong post indexed");
});

await check("the build reads it back and renders it", async () => {
  const posts = await loadPublishedPosts({ store });
  assert(posts.length === 1, `expected 1 post, got ${posts.length}`);
  assert(posts[0].title === "Probe post", "title did not survive");
  assert(/class="katex/.test(posts[0].html), "math did not render");
  assert(posts[0].math === true, "math flag not set");
  assert(posts[0].description === "Written by verify-publish.", "description lost");
});

await check("a double publish of the same revision publishes once", async () => {
  const before = hookCalls.length;
  const key = `${published.postId}:${published.revisionId}`;
  const a = await publisher.publish(published, { idempotencyKey: key });
  const b = await publisher.publish(published, { idempotencyKey: key });
  assert(a.jobId === b.jobId, "two jobs for one revision");
  assert(hookCalls.length === before, "a repeat publish triggered another rebuild");
});

await check("another post cannot take the same slug", async () => {
  const { draft } = await drafts.create({
    title: "Probe post", date: "2026-09-11", body: "A rival with the same title.",
  });
  let err;
  try { await publisher.publish(draft); } catch (e) { err = e; }
  assert(err instanceof PublishError && err.code === "slug_taken", `expected slug_taken, got ${err?.code}`);
  const posts = await loadPublishedPosts({ store });
  assert(posts.length === 1, "the rival got published anyway");
  assert(posts[0].postId === published.postId, "the rival took the slug");
});

await check("editing and republishing replaces rather than duplicates", async () => {
  const current = await drafts.get(published.postId);
  const saved = await drafts.save(published.postId, { body: "Revised body." }, current.etag);
  await publisher.publish(saved.draft);
  const posts = await loadPublishedPosts({ store });
  assert(posts.length === 1, `expected 1 post after republish, got ${posts.length}`);
  assert(/Revised body\./.test(posts[0].html), "the revision did not take effect");
});

await check("unpublishing removes it but keeps the revision", async () => {
  await publisher.unpublish(published.postId);
  const posts = await loadPublishedPosts({ store });
  assert(posts.length === 0, "still published");
  const keys = await store.listAll("published/posts/");
  assert(keys.length > 0, "revisions were destroyed, so rollback is impossible");
});

await check("the publications list reads it back: off the site, both revisions stored, newest first", async () => {
  const listed = (await publisher.listPublications()).find((p) => p.postId === published.postId);
  assert(listed && listed.published === false, "the unpublished post is missing, or still marked published");
  assert(listed.revisions.length === 2, `expected 2 stored revisions, got ${listed.revisions.length}`);
  assert(listed.revisions[0].revisionId > listed.revisions[1].revisionId, "revisions are not newest first");
  assert(listed.revisions.every((r) => !Number.isNaN(Date.parse(r.storedAt))), "a stored time did not come back");
});

await check("it is put back, then rolled back to its first revision, and each is what builds", async () => {
  const listed = (await publisher.listPublications()).find((p) => p.postId === published.postId);
  const [newest, oldest] = listed.revisions.map((r) => r.revisionId);

  const back = await publisher.rollback(published.postId, newest);
  assert(back.changed && back.slug === "probe-post", `putting it back changed nothing: ${JSON.stringify(back)}`);
  let posts = await loadPublishedPosts({ store });
  assert(posts.length === 1 && /Revised body\./.test(posts[0].html), "the revision put back is not what builds");

  const older = await publisher.rollback(published.postId, oldest);
  assert(older.changed, "rolling back changed nothing");
  posts = await loadPublishedPosts({ store });
  assert(/Body with inline math/.test(posts[0].html), "the first revision is not what builds after rolling back");
});

await check("the inventory tree describes what is actually in the bucket", async () => {
  // Republish so there is a superseded revision to account for.
  const current = await drafts.get(published.postId);
  await drafts.save(published.postId, { body: "Another revision." }, current.etag);
  const latest = await drafts.get(published.postId);
  await publisher.publish(latest.draft);

  const tree = await buildInventory(store);
  const post = tree.posts.find((p) => p.postId === published.postId);
  assert(post, "the post is missing from the inventory");
  assert(post.state === "published", `expected published, got ${post.state}`);
  assert(post.revisions.filter((r) => r.kind === "published").length >= 2,
    "superseded revisions are not tracked");
  assert(post.revisions.filter((r) => r.current).length >= 1, "no current revision marked");

  const stored = await store.getJson(INVENTORY_KEY);
  assert(stored, "publishing did not refresh inventory.json");
});

await check("a sweep keeps everything the live site needs", async () => {
  const tree = await buildInventory(store);
  const post = tree.posts.find((p) => p.postId === published.postId);
  const doomed = collectableForPost(post).map((d) => d.key);
  assert(!doomed.some((k) => k.includes(post.publishedRevisionId)),
    "the live revision was marked collectable");

  const swept = await collectGarbage(store, { apply: false });
  assert(swept.deleted === 0, "a dry run deleted something");
  for (const key of swept.keys) {
    assert(!key.includes(post.publishedRevisionId), `the live revision was marked for deletion: ${key}`);
  }
  // Every key a sweep names must belong to a post it was scoped to.
  const { classifyKey } = await import("../lib/server/keys.mjs");
  for (const key of swept.keys) {
    assert(classifyKey(key).owned, `a sweep named an unowned key: ${key}`);
  }

  // The site must still render after a real sweep.
  await collectGarbage(store, { apply: true });
  const posts = await loadPublishedPosts({ store });
  assert(posts.length === 1, `the sweep changed what is published (${posts.length} posts)`);
});

// ---- cleanup ---------------------------------------------------------------
console.log("\nCleaning up...");
const leftover = await store.listAll("");
for (const { key } of leftover) await store.delete(key);
console.log(`Deleted ${leftover.length} objects.`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} publish checks passed`);
console.log(`Deploy hook called ${hookCalls.length} time(s)${fireForReal ? "" : " (stubbed)"}.`);
if (failed.length) process.exit(1);
