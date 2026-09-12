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
import { probePrefix, cleanUpOnExit, sweepStaleProbes } from "./probe-prefix.mjs";

const fireForReal = process.argv.includes("--fire-hook");

const config = { ...loadR2Config(), prefix: probePrefix("pub") };
const store = createStore({ config });
// Cleanup no longer waits for the script to finish: Ctrl-C and an escaping
// exception both sweep this run's prefix on the way out (scripts/probe-prefix.mjs).
const sweep = cleanUpOnExit(store, { label: config.prefix });
// Debris an earlier interrupted run could not sweep itself. Older than an hour
// only, so a check running right now keeps its working set.
const abandoned = await sweepStaleProbes(config);
if (abandoned) console.log(`Removed ${abandoned} object(s) left by an earlier interrupted run.\n`);
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

await check("a failed build records why, and a build that succeeds clears it", async () => {
  // The editor watches the public build manifest, which a failed build never
  // publishes. Without this record, waiting cannot tell a broken build from a
  // slow one (Step 7).
  const { keys } = await import("../lib/server/keys.mjs");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "verify-build-"));
  const runBuild = () => spawnSync(process.execPath, ["build.mjs"], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, R2_PREFIX: config.prefix, BLOG_DIST_DIR: dist, BLOG_POSTS_DIR: "" },
  });
  const cacheDir = path.join(ROOT, "node_modules", ".cache", "weblog-media");

  // A post with an image of its own, so this check does not depend on what the
  // checks above happened to leave behind.
  const { createUploads } = await import("../lib/server/uploads.mjs");
  const uploads = createUploads(store, { signPut: async (key) => `https://unused/${key}` });
  const png = fs.readFileSync(path.join(ROOT, "test", "fixtures", "media", "sample-7x11.png"));
  const withImage = await drafts.create({
    title: "Has an image", date: "2026-07-09", body: "x", slug: `imaged-${Date.now().toString(36)}`,
  });
  const pending = await uploads.sign({
    postId: withImage.draft.postId, name: "diagram.png", size: png.length, type: "image/png",
  });
  await store.put(keys.upload(withImage.draft.postId, pending.uploadId, "file"), png);
  const attachment = await uploads.complete({ postId: withImage.draft.postId, uploadId: pending.uploadId });
  const ready = await drafts.save(withImage.draft.postId,
    { ...withImage.draft, body: `Body.\n\n![a diagram](attachment://${attachment.id})` }, withImage.etag);
  await publisher.publish(ready.draft);

  // Break the build the way a real one breaks: a published revision naming
  // media that is no longer there.
  const media = await store.listAll("published/media/");
  assert(media.length > 0, "no media was published to break");
  const victim = media[0];
  const bytes = (await store.get(victim.key)).body;
  await store.delete(victim.key);
  fs.rmSync(cacheDir, { recursive: true, force: true });

  const failed = runBuild();
  assert(failed.status !== 0, "the build succeeded with its media missing");
  const reported = await publisher.lastBuildFailure();
  assert(reported, "a failed build left no record of why");
  assert(reported.kind === "media", `expected a media failure, got ${reported.kind}`);
  assert(/missing/i.test(reported.reason), `the reason does not say what happened: ${reported.reason}`);

  // Put it back: the next successful build must clear the record, so its
  // presence always means the most recent build failed.
  await store.put(victim.key, bytes);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const ok = runBuild();
  assert(ok.status === 0, `the build still failed: ${ok.stderr?.trim().slice(0, 200)}`);
  assert(await publisher.lastBuildFailure() === null, "a successful build left the old failure behind");

  fs.rmSync(dist, { recursive: true, force: true });
});

// ---- cleanup ---------------------------------------------------------------
console.log("\nCleaning up...");
console.log(`Deleted ${await sweep()} objects.`);
// Debris from a run that was interrupted before it could tidy up. Older than
// an hour only, so a check running alongside this one keeps its working set.
const stale = await sweepStaleProbes(config);
if (stale) console.log(`Also removed ${stale} object(s) left by an earlier interrupted run.`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} publish checks passed`);
console.log(`Deploy hook called ${hookCalls.length} time(s)${fireForReal ? "" : " (stubbed)"}.`);
if (failed.length) process.exit(1);
