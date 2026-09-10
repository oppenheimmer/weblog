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
  await publisher.unpublish("probe-post");
  const posts = await loadPublishedPosts({ store });
  assert(posts.length === 0, "still published");
  const keys = await store.listAll("published/posts/");
  assert(keys.length > 0, "revisions were destroyed, so rollback is impossible");
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
