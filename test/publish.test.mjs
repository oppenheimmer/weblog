// Tier 3 — publication.
//
// Step 6's acceptance: one Publish produces one published revision and one
// rebuild; double-clicks, racing slugs and concurrent publishes neither lose
// content nor duplicate posts.
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import {
  createPublisher, validateForPublish, contentDigest, PublishError, INDEX_KEY, revisionKey,
} from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

/** A publisher with a recording stand-in for the deploy hook. */
function harness({ hook } = {}) {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const calls = [];
  const fireDeployHook = hook ?? (async () => { calls.push(Date.now()); return { job: "d1" }; });
  return {
    store,
    calls,
    publisher: createPublisher(store, { fireDeployHook }),
    drafts: createDraftStore(store),
  };
}

const complete = (over = {}) => ({
  postId: "p_00000000000000aa", revisionId: "r_000001_abc_1234", version: 1,
  title: "A complete post", date: "2026-07-01", description: "Desc",
  tags: ["meta"], format: "markdown", body: "Body text.", slug: "a-complete-post",
  ...over,
});

// ---------------------------------------------------------------- validation

test("an incomplete draft cannot be published, and says which field is missing", () => {
  for (const [field, draft] of [
    ["title", complete({ title: "" })],
    ["date", complete({ date: "" })],
    ["body", complete({ body: "   " })],
    ["slug", complete({ slug: "" })],
  ]) {
    const err = (() => { try { validateForPublish(draft); } catch (e) { return e; } })();
    assert.ok(err instanceof PublishError, `${field} was accepted`);
    assert.equal(err.field, field);
  }
});

test("a reserved slug is refused at publish, not just at build", () => {
  const err = (() => { try { validateForPublish(complete({ slug: "tags" })); } catch (e) { return e; } })();
  assert.ok(err instanceof PublishError);
  assert.match(err.message, /reserved/);
});

test("content that cannot be rendered is refused before it can break a build", () => {
  const err = (() => {
    try { validateForPublish(complete({ date: "not-a-date" })); } catch (e) { return e; }
  })();
  assert.ok(err instanceof PublishError);
  assert.equal(err.code, "invalid_content");
});

test("the digest covers content, not bookkeeping", () => {
  const base = complete();
  assert.equal(contentDigest(base), contentDigest({ ...base, publishedAt: "later" }));
  assert.notEqual(contentDigest(base), contentDigest({ ...base, body: "different" }));
});

// ---------------------------------------------------------------- publishing

test("publishing writes a revision, indexes it, and fires the hook once", async () => {
  const { publisher, store, calls } = harness();
  const job = await publisher.publish(complete());

  assert.equal(job.state, "building");
  assert.equal(calls.length, 1, "expected exactly one rebuild");

  const revision = await store.getJson(revisionKey("p_00000000000000aa", "r_000001_abc_1234"));
  assert.equal(revision.data.title, "A complete post");

  const index = await store.getJson(INDEX_KEY);
  assert.equal(index.data.posts["a-complete-post"].postId, "p_00000000000000aa");
});

test("the hook fires only after the index write, never before", async () => {
  const order = [];
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const publisher = createPublisher(store, {
    fireDeployHook: async () => {
      // Firing first would build content that does not exist yet.
      const index = await store.getJson(INDEX_KEY);
      order.push(index?.data.posts["a-complete-post"] ? "index-first" : "hook-first");
      return {};
    },
  });
  await publisher.publish(complete());
  assert.deepEqual(order, ["index-first"]);
});

test("a repeated publish of the same revision publishes once", async () => {
  const { publisher, calls } = harness();
  const draft = complete();
  const first = await publisher.publish(draft, { idempotencyKey: "same-key" });
  const second = await publisher.publish(draft, { idempotencyKey: "same-key" });

  assert.equal(first.jobId, second.jobId);
  assert.equal(calls.length, 1, "a double-click triggered two rebuilds");
});

test("publishing the same revision twice is idempotent without any caller effort", async () => {
  // The route supplies a key, but a direct caller might not. Idempotency that
  // depends on remembering is not idempotency.
  const { publisher, calls } = harness();
  const draft = complete();
  const first = await publisher.publish(draft);
  const second = await publisher.publish(draft);

  assert.equal(first.jobId, second.jobId, "the same revision produced two jobs");
  assert.equal(calls.length, 1, "the same revision triggered two rebuilds");
});

test("a genuinely new revision does publish again", async () => {
  const { publisher, calls } = harness();
  await publisher.publish(complete());
  await publisher.publish(complete({ revisionId: "r_000002_new_0001", body: "Changed." }));
  assert.equal(calls.length, 2, "a real edit did not trigger a rebuild");
});

test("two posts racing for one slug: the second is refused, not silently swapped", async () => {
  const { publisher, store } = harness();
  await publisher.publish(complete());

  const rival = complete({ postId: "p_00000000000000bb", revisionId: "r_000001_zzz_9999" });
  const err = await publisher.publish(rival).then(() => null, (e) => e);
  assert.ok(err instanceof PublishError);
  assert.equal(err.code, "slug_taken");

  const index = await store.getJson(INDEX_KEY);
  assert.equal(index.data.posts["a-complete-post"].postId, "p_00000000000000aa",
    "the loser took over the slug");
});

test("republishing the same post under its own slug is allowed", async () => {
  const { publisher, store } = harness();
  await publisher.publish(complete());
  await publisher.publish(complete({ revisionId: "r_000002_bbb_5678", body: "Revised." }));

  const index = await store.getJson(INDEX_KEY);
  assert.equal(index.data.posts["a-complete-post"].revisionId, "r_000002_bbb_5678");
  const posts = await loadPublishedPosts({ store });
  assert.equal(posts.length, 1, "republishing created a duplicate");
  assert.match(posts[0].html, /Revised\./);
});

test("a failed hook leaves the post published, not failed", async () => {
  const { publisher, store } = harness({
    hook: async () => { throw new Error("hook unreachable"); },
  });
  const job = await publisher.publish(complete());

  // Past the commit point the post IS published; only the rebuild is missing,
  // which is recoverable and must not be reported as a lost publish.
  assert.equal(job.state, "published");
  assert.match(job.hookError, /rebuild could not be triggered/);
  const index = await store.getJson(INDEX_KEY);
  assert.ok(index.data.posts["a-complete-post"], "the post was not indexed");
});

test("a validation failure writes no revision and no index entry", async () => {
  const { publisher, store } = harness();
  await assert.rejects(() => publisher.publish(complete({ title: "" })), PublishError);
  assert.equal(await store.getJson(INDEX_KEY), null);
});

// ---------------------------------------------------------------- build side

test("published revisions render through the same pipeline as files", async () => {
  const { publisher, store } = harness();
  await publisher.publish(complete({
    body: "# Heading\n\nInline math $E = mc^2$ and text.",
    tags: ["math", "meta"],
  }));

  const posts = await loadPublishedPosts({ store });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].slug, "a-complete-post");
  assert.match(posts[0].html, /class="katex/, "math did not render");
  assert.equal(posts[0].math, true);
  assert.deepEqual(posts[0].tags, ["math", "meta"]);
  assert.equal(posts[0].date, "2026-07-01T00:00:00.000Z");
});

test("LaTeX posts render from R2 too", async () => {
  const { publisher, store } = harness();
  await publisher.publish(complete({
    format: "latex", slug: "a-latex-post", body: "\\section{Hi}\nText.",
  }));
  const posts = await loadPublishedPosts({ store });
  assert.match(posts[0].html, /Hi/);
  assert.ok(!posts[0].html.includes("\\section"), "LaTeX leaked unrendered");
});

test("published posts come back newest first", async () => {
  const { publisher, store } = harness();
  for (const [n, date] of [["older", "2026-01-01"], ["newer", "2026-08-01"]]) {
    await publisher.publish(complete({
      // 16 hex digits, like every real post id — publishing lists the post's
      // attachments now, and that validates the id the draft store always had.
      postId: `p_00000000000000${n === "older" ? "01" : "02"}`,
      revisionId: `r_000001_${n}_0001`, slug: n, title: n, date,
    }));
  }
  const posts = await loadPublishedPosts({ store });
  assert.deepEqual(posts.map((p) => p.slug), ["newer", "older"]);
});

// ---------------------------------------------------------------- unpublish

test("unpublishing removes the post but keeps the revision for rollback", async () => {
  const { publisher, store } = harness();
  await publisher.publish(complete());
  await publisher.unpublish("a-complete-post");

  assert.deepEqual(await loadPublishedPosts({ store }), []);
  const revision = await store.getJson(revisionKey("p_00000000000000aa", "r_000001_abc_1234"));
  assert.ok(revision, "the revision was destroyed, making rollback impossible");
});

test("unpublishing something absent is a no-op, not an error", async () => {
  const { publisher } = harness();
  assert.deepEqual(await publisher.unpublish("never-existed"), { ok: true, changed: false });
});

// ---------------------------------------------------------------- end to end

test("a draft saved through the draft store publishes and renders", async () => {
  const { publisher, drafts, store } = harness();
  const { draft } = await drafts.create({
    title: "Written in the editor", date: "2026-09-11",
    tags: ["meta"], body: "Hello from the editor.", format: "markdown",
  });

  const job = await publisher.publish(draft);
  assert.equal(job.slug, "written-in-the-editor");

  const posts = await loadPublishedPosts({ store });
  assert.equal(posts[0].title, "Written in the editor");
  assert.match(posts[0].html, /Hello from the editor\./);
});
