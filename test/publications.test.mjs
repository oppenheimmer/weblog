// Tier 3 and 5 — a post after its commit point (CLAUDE.md Step 6, Step 7).
//
// Republishing, retrying a publish that stopped part way, taking a post down,
// putting an older revision back, and knowing whether the site shows it yet.
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { PutObjectCommand } from "@aws-sdk/client-s3";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createPublisher, PublishError, INDEX_KEY, revisionKey } from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { keys } from "../lib/server/keys.mjs";
import { createSessionStore, csrfToken } from "../lib/server/sessions.mjs";
import { createRateLimiter } from "../lib/server/rate-limit.mjs";
import { setContext, cookieName } from "../lib/server/http.mjs";
import publishRoute from "../api/publish.js";
import draftById from "../api/drafts/[id]/index.js";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const A = "p_00000000000000aa";
const B = "p_00000000000000bb";
const MINUTE = 60 * 1000;

/** A publisher over a fake bucket, with a deploy hook that records its calls. */
function harness({ hook, now } = {}) {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  const hooks = [];
  const fireDeployHook = async () => {
    hooks.push(hooks.length + 1);
    return hook ? hook(hooks.length) : { job: `d${hooks.length}` };
  };
  return {
    store, client, hooks,
    publisher: createPublisher(store, { fireDeployHook, ...(now ? { now } : {}) }),
    drafts: createDraftStore(store),
  };
}

const post = (over = {}) => ({
  postId: A, revisionId: "r_000001_abc_1234", version: 1,
  title: "A post", date: "2026-07-01", description: "", tags: [],
  format: "markdown", body: "First.", slug: "a-post", ...over,
});

const indexOf = async (store) => (await store.getJson(INDEX_KEY))?.data.posts ?? {};
const rejection = (promise) => promise.then(() => null, (err) => err);

// ---------------------------------------------------------------- the address

test("a published post keeps its address: republishing under a new slug is refused", async () => {
  // Otherwise the index gains a second entry for the same post, and the build
  // emits it at both URLs.
  const { publisher, store } = harness();
  await publisher.publish(post());

  const err = await rejection(publisher.publish(post({ revisionId: "r_000002_abc_5678", slug: "renamed" })));
  assert.ok(err instanceof PublishError, `expected a refusal, got ${err}`);
  assert.equal(err.code, "slug_locked");
  assert.equal(err.field, "slug");
  assert.deepEqual(Object.keys(await indexOf(store)), ["a-post"]);
});

// ---------------------------------------------------------------- discarding

test("discarding the draft of a published post is refused, and its published copy survives", async () => {
  // The draft's objects and the published revision share the post's prefixes,
  // so discarding used to delete what the index still names.
  const { publisher, drafts, store } = harness();
  const { draft } = await drafts.create({ title: "Kept", date: "2026-07-01", body: "Live text." });
  await publisher.publish(draft);

  const err = await rejection(drafts.remove(draft.postId));
  assert.ok(err, "the draft of a published post was discarded");
  assert.equal(err.status, 409);
  assert.equal(err.code, "post_published");
  assert.ok(await store.getJson(revisionKey(draft.postId, draft.revisionId)), "the published revision was deleted");
  assert.ok(await drafts.get(draft.postId), "the draft was deleted anyway");
});

// ---------------------------------------------------------------- retrying

test("publishing again after the rebuild could not be triggered fires the hook again", async () => {
  const { publisher, hooks } = harness({
    hook: (call) => { if (call === 1) throw new Error("hook unreachable"); return { job: "d2" }; },
  });
  const first = await publisher.publish(post());
  assert.ok(first.hookError, "the first hook call was meant to fail");

  const retried = await publisher.publish(post());
  assert.equal(hooks.length, 2, "the retry did not fire the hook");
  assert.equal(retried.state, "building");
  assert.equal(retried.hookError, undefined, "the old hook error was left on a job that has since rebuilt");
  assert.equal(retried.jobId, first.jobId);
});

test("a publish interrupted mid-write resumes once its lease has run out", async () => {
  let clock = Date.parse("2026-09-12T10:00:00Z");
  const { publisher, store, hooks } = harness({ now: () => new Date(clock).toISOString() });

  // What a function killed between writing its job and the commit point leaves.
  const jobId = `j_${crypto.createHash("sha256").update(`${A}:r_000001_abc_1234`).digest("hex").slice(0, 16)}`;
  await store.putJson(keys.job(jobId), {
    jobId, postId: A, revisionId: "r_000001_abc_1234", slug: "a-post", digest: "x",
    state: "writing", createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString(),
    attempts: 1, error: null,
  });

  clock += MINUTE;
  const early = await publisher.publish(post());
  assert.equal(early.state, "writing", "a publish still inside its lease was run twice");
  assert.deepEqual(await indexOf(store), {});

  clock += 10 * MINUTE;
  const resumed = await publisher.publish(post());
  assert.equal(resumed.state, "building");
  assert.equal(resumed.attempts, 2);
  assert.equal((await indexOf(store))["a-post"]?.revisionId, "r_000001_abc_1234");
  assert.equal(hooks.length, 1);
});

test("a publish refused for its address leaves no revision behind to be offered for rollback", async () => {
  const { publisher } = harness();
  await publisher.publish(post());
  await rejection(publisher.publish(post({ revisionId: "r_000002_abc_5678", slug: "renamed" })));

  const [listed] = await publisher.listPublications();
  assert.deepEqual(listed.revisions.map((r) => r.revisionId), ["r_000001_abc_1234"]);
});

// ---------------------------------------------------------------- unpublishing

test("unpublishing takes the post out of the index and rebuilds, keeping its revision", async () => {
  const { publisher, store, hooks } = harness();
  await publisher.publish(post());

  assert.deepEqual(await publisher.unpublish(A), { ok: true, changed: true, slug: "a-post", rebuilding: true });
  assert.deepEqual(await indexOf(store), {});
  assert.equal(hooks.length, 2);
  assert.ok(await store.getJson(revisionKey(A, "r_000001_abc_1234")), "the revision went too, so it cannot be put back");
});

test("an unpublish whose rebuild could not be triggered still unpublishes, and says so", async () => {
  const { publisher, store } = harness({
    hook: (call) => { if (call === 2) throw new Error("hook unreachable"); return {}; },
  });
  await publisher.publish(post());

  const result = await publisher.unpublish(A);
  assert.equal(result.changed, true);
  assert.equal(result.rebuilding, false);
  assert.match(result.hookError, /could not be triggered: hook unreachable/);
  assert.deepEqual(await indexOf(store), {});
});

test("unpublishing one post leaves every other post where it is", async () => {
  const { publisher, store } = harness();
  await publisher.publish(post());
  await publisher.publish(post({ postId: B, revisionId: "r_000001_def_0001", slug: "b-post", title: "B" }));

  await publisher.unpublish(A);
  assert.deepEqual(Object.keys(await indexOf(store)), ["b-post"]);
});

test("an unpublish that races another index write re-reads rather than undoing it", async () => {
  const { publisher, store, client } = harness();
  await publisher.publish(post());
  await publisher.publish(post({ postId: B, revisionId: "r_000001_def_0001", slug: "b-post", title: "B" }));

  // Another writer's change lands between the unpublish's read and its write.
  const send = client.send.bind(client);
  let interfered = false;
  client.send = async (command) => {
    const key = String(command.input?.Key);
    if (!interfered && command.constructor.name === "PutObjectCommand" && key.endsWith(INDEX_KEY)) {
      interfered = true;
      const theirs = JSON.parse(client.objects.get(key).body.toString("utf8"));
      theirs.posts["b-post"].publishedAt = "written by someone else";
      await send(new PutObjectCommand({ Bucket: FAKE_CONFIG.bucket, Key: key, Body: JSON.stringify(theirs) }));
    }
    return send(command);
  };

  assert.equal((await publisher.unpublish(A)).changed, true);
  const posts = await indexOf(store);
  assert.ok(interfered, "the race was never staged");
  assert.deepEqual(Object.keys(posts), ["b-post"]);
  assert.equal(posts["b-post"].publishedAt, "written by someone else", "the other writer's change was lost");
});

test("unpublishing needs a real post id", async () => {
  const { publisher } = harness();
  for (const postId of ["a-post", "../index", undefined, 7]) {
    const err = await rejection(publisher.unpublish(postId));
    assert.equal(err?.code, "invalid_post", `${postId} was accepted`);
  }
  assert.deepEqual(await publisher.unpublish("p_000000000000ffff"), { ok: true, changed: false });
});

test("once unpublished, the draft can be discarded", async () => {
  const { publisher, drafts } = harness();
  const { draft } = await drafts.create({ title: "Short-lived", date: "2026-07-01", body: "Gone soon." });
  await publisher.publish(draft);
  await publisher.unpublish(draft.postId);

  assert.ok((await drafts.remove(draft.postId)) > 0);
  assert.equal(await drafts.get(draft.postId), null);
});

// ---------------------------------------------------------------- rolling back

test("rolling back points the index at the earlier revision, and the build renders it", async () => {
  const { publisher, store, hooks } = harness();
  await publisher.publish(post());
  await publisher.publish(post({ revisionId: "r_000002_abc_5678", body: "Second." }));

  assert.deepEqual(await publisher.rollback(A, "r_000001_abc_1234"),
    { ok: true, changed: true, slug: "a-post", rebuilding: true });
  assert.equal((await indexOf(store))["a-post"].revisionId, "r_000001_abc_1234");
  assert.equal(hooks.length, 3);
  const [rendered] = await loadPublishedPosts({ store });
  assert.match(rendered.html, /First\./);
});

test("rolling back to the revision already on the site changes nothing and rebuilds nothing", async () => {
  const { publisher, hooks } = harness();
  await publisher.publish(post());
  assert.deepEqual(await publisher.rollback(A, "r_000001_abc_1234"), { ok: true, changed: false, slug: "a-post" });
  assert.equal(hooks.length, 1);
});

test("an unpublished post is put back from its stored revision", async () => {
  const { publisher, store } = harness();
  await publisher.publish(post());
  await publisher.unpublish(A);

  assert.equal((await publisher.rollback(A, "r_000001_abc_1234")).changed, true);
  assert.equal((await indexOf(store))["a-post"]?.revisionId, "r_000001_abc_1234");
});

test("only a revision stored for that post can be rolled back to", async () => {
  const { publisher, store } = harness();
  await publisher.publish(post());
  for (const [postId, revisionId] of [
    [A, "r_000009_zzz_0000"], [A, "../../index"], [A, undefined], [A, 7], [B, "r_000001_abc_1234"],
  ]) {
    const err = await rejection(publisher.rollback(postId, revisionId));
    assert.equal(err?.code, "not_found", `${postId}/${revisionId} was accepted`);
  }
  assert.equal((await indexOf(store))["a-post"].revisionId, "r_000001_abc_1234");
});

test("a misfiled revision is never put back under a post that does not own it", async () => {
  // The record's own post id decides, not only where it was found. Otherwise a
  // copy under another post's prefix would publish one post's text as another.
  const { publisher, store } = harness();
  await publisher.publish(post());
  const record = (await store.getJson(revisionKey(A, "r_000001_abc_1234"))).data;
  await store.putJson(revisionKey(B, "r_000001_abc_1234"), record);
  await publisher.unpublish(A);

  const err = await rejection(publisher.rollback(B, "r_000001_abc_1234"));
  assert.equal(err?.code, "not_found");
  assert.deepEqual(await indexOf(store), {});
});

test("a revision whose image is no longer stored is refused before the index changes", async () => {
  const { publisher, store } = harness();
  await publisher.publish(post());
  const stored = (await store.getJson(revisionKey(A, "r_000001_abc_1234"))).data;
  await store.putJson(revisionKey(A, "r_000000_old_0000"), {
    ...stored, revisionId: "r_000000_old_0000",
    media: [{ id: "a_00000000000000a1", publicName: "diagram.png", mediaType: "image/png", bytes: 3, sha256: "0", width: 1, height: 1 }],
  });

  const err = await rejection(publisher.rollback(A, "r_000000_old_0000"));
  assert.equal(err?.code, "media_missing");
  assert.equal((await indexOf(store))["a-post"].revisionId, "r_000001_abc_1234");

  await store.put(keys.media(A, "diagram.png"), Buffer.from("png"));
  assert.equal((await publisher.rollback(A, "r_000000_old_0000")).changed, true, "a revision with its image present was refused");
});

test("rolling back cannot move a published post to another address", async () => {
  // A post unpublished, then republished under a new slug, still has revisions
  // stored under the old one.
  const { publisher, store } = harness();
  await publisher.publish(post({ slug: "old-address" }));
  await publisher.unpublish(A);
  await publisher.publish(post({ revisionId: "r_000002_abc_5678", slug: "new-address" }));
  assert.deepEqual(Object.keys(await indexOf(store)), ["new-address"], "an unpublished post could not change address");

  const err = await rejection(publisher.rollback(A, "r_000001_abc_1234"));
  assert.equal(err?.code, "slug_locked");
  assert.deepEqual(Object.keys(await indexOf(store)), ["new-address"]);
});

test("a post cannot be put back at an address another post has taken since", async () => {
  const { publisher, store } = harness();
  await publisher.publish(post());
  await publisher.unpublish(A);
  await publisher.publish(post({ postId: B, revisionId: "r_000001_def_0001", title: "B" }));

  const err = await rejection(publisher.rollback(A, "r_000001_abc_1234"));
  assert.equal(err?.code, "slug_taken");
  assert.equal((await indexOf(store))["a-post"].postId, B);
});

test("a revision rolled back from can be published again", async () => {
  // Its job still says it went out, but the index has moved on. Answering with
  // that job would tell the author it is published while the site shows another.
  const { publisher, store, hooks } = harness();
  await publisher.publish(post());
  await publisher.publish(post({ revisionId: "r_000002_abc_5678", body: "Second." }));
  await publisher.rollback(A, "r_000001_abc_1234");

  const again = await publisher.publish(post({ revisionId: "r_000002_abc_5678", body: "Second." }));
  assert.equal(again.state, "building");
  assert.equal((await indexOf(store))["a-post"].revisionId, "r_000002_abc_5678");
  assert.equal(hooks.length, 4);
});

test("an unpublished post is published again from its unchanged draft", async () => {
  const { publisher, store } = harness();
  await publisher.publish(post());
  await publisher.unpublish(A);

  const again = await publisher.publish(post());
  assert.equal(again.attempts, 2);
  assert.equal((await indexOf(store))["a-post"]?.revisionId, "r_000001_abc_1234");
});

// ---------------------------------------------------------------- listing

test("the publications list shows posts on and off the site, with stored revisions newest first", async () => {
  const { publisher } = harness();
  await publisher.publish(post());
  await publisher.publish(post({ revisionId: "r_000002_abc_5678", body: "Second." }));
  await publisher.publish(post({ postId: B, revisionId: "r_000001_def_0001", slug: "b-post", title: "B" }));
  await publisher.unpublish(B);

  const list = await publisher.listPublications();
  assert.deepEqual(list.map((p) => [p.postId, p.published, p.slug, p.title, p.revisionId]), [
    [A, true, "a-post", "A post", "r_000002_abc_5678"],
    [B, false, "b-post", "B", null],
  ]);
  assert.deepEqual(list[0].revisions.map((r) => [r.revisionId, r.version]),
    [["r_000002_abc_5678", 2], ["r_000001_abc_1234", 1]]);
  assert.ok(list[0].revisions.every((r) => !Number.isNaN(Date.parse(r.storedAt))));
});

// ---------------------------------------------------------------- the route

/** A signed-in context over a fake bucket, with the hook and the site stubbed. */
function routeHarness({ manifest = { ok: true, commit: "c1", posts: [] } } = {}) {
  const { store, publisher, drafts } = harness();
  const sessions = createSessionStore(store, { authVersion: 1 });
  const hooks = [];
  setContext({
    store, sessions,
    limiter: createRateLimiter(store, { secret: "test-secret" }),
    fireDeployHook: async () => { hooks.push(1); return { job: "d" }; },
    readManifest: async () => manifest,
  });
  return { store, publisher, drafts, sessions, hooks };
}

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    end(payload) { this.body = payload; return this; },
  };
}

async function headersFor(h, { signedIn = true, csrf = true } = {}) {
  const headers = { origin: "http://localhost:3000" };
  if (!signedIn) return headers;
  const { token, session } = await h.sessions.create();
  headers.cookie = `${cookieName()}=${token}`;
  if (csrf) headers["x-csrf-token"] = csrfToken(session);
  return headers;
}

async function call(h, { method = "GET", body, ...who } = {}) {
  const res = fakeRes();
  await publishRoute({ method, url: "/api/publish/", headers: await headersFor(h, who), body }, res);
  return { status: res.statusCode, json: JSON.parse(res.body ?? "null") };
}

test("the route changes nothing for anyone but the signed-in owner with a CSRF token", async () => {
  const h = routeHarness();
  await h.publisher.publish(post());

  assert.equal((await call(h, { signedIn: false })).status, 401);
  for (const body of [
    { action: "unpublish", postId: A }, { action: "rebuild" },
    { action: "rollback", postId: A, revisionId: "r_000001_abc_1234" },
  ]) {
    assert.equal((await call(h, { method: "POST", body, signedIn: false })).status, 401);
    assert.equal((await call(h, { method: "POST", body, csrf: false })).status, 403);
  }
  assert.deepEqual(Object.keys(await indexOf(h.store)), ["a-post"]);
  assert.equal(h.hooks.length, 0);
});

test("the route lists each publication with what the site shows", async () => {
  const h = routeHarness({
    manifest: { ok: true, commit: "c9", posts: [{ slug: "a-post", postId: A, revisionId: "r_000001_abc_1234" }] },
  });
  await h.publisher.publish(post());
  await h.publisher.publish(post({ postId: B, revisionId: "r_000001_def_0001", slug: "b-post", title: "B" }));

  const { status, json } = await call(h);
  assert.equal(status, 200);
  assert.deepEqual(json.site, { ok: true, commit: "c9" });
  assert.deepEqual(Object.fromEntries(json.publications.map((p) => [p.slug, p.site.state])),
    { "a-post": "live", "b-post": "pending" });
});

test("a site that cannot be read is reported as such, and the list still comes back", async () => {
  const h = routeHarness({ manifest: { ok: false, checkable: true, reason: "the site could not be reached" } });
  await h.publisher.publish(post());

  const { json } = await call(h);
  assert.deepEqual(json.site, { ok: false, checkable: true, reason: "the site could not be reached" });
  assert.equal(json.publications[0].site.state, "unknown");
});

test("rollback, unpublish and rebuild go through the route", async () => {
  const h = routeHarness();
  await h.publisher.publish(post());
  await h.publisher.publish(post({ revisionId: "r_000002_abc_5678", body: "Second." }));

  const back = await call(h, { method: "POST", body: { action: "rollback", postId: A, revisionId: "r_000001_abc_1234" } });
  assert.deepEqual([back.status, back.json.changed], [200, true]);
  assert.equal((await indexOf(h.store))["a-post"].revisionId, "r_000001_abc_1234");

  const down = await call(h, { method: "POST", body: { action: "unpublish", postId: A } });
  assert.deepEqual(down.json, { ok: true, changed: true, slug: "a-post", rebuilding: true });

  const rebuilt = await call(h, { method: "POST", body: { action: "rebuild" } });
  assert.deepEqual(rebuilt.json, { triggered: true, hook: { job: "d" } });
  assert.equal(h.hooks.length, 3);
});

test("refusals come back as structured errors, naming the field when there is one", async () => {
  const h = routeHarness();
  const { draft } = await h.drafts.create({ title: "A post", date: "2026-07-01", body: "Text.", slug: "a-post" });
  assert.equal((await call(h, { method: "POST", body: { postId: draft.postId } })).status, 200);

  const saved = await h.drafts.get(draft.postId);
  await h.drafts.save(draft.postId, { slug: "renamed" }, saved.etag);
  const moved = await call(h, { method: "POST", body: { postId: draft.postId } });
  assert.equal(moved.status, 409);
  assert.equal(moved.json.code, "slug_locked");
  assert.ok(moved.json.fields?.slug, "the refusal does not point at the slug field");

  for (const [body, code] of [
    [{ action: "rollback", postId: draft.postId, revisionId: "r_000009_x_0" }, "not_found"],
    [{ action: "unpublish" }, "post_required"],
    [{ action: "unpublish", postId: "../index" }, "invalid_post"],
    [{ action: "delete-everything", postId: draft.postId }, "unknown_action"],
  ]) {
    assert.equal((await call(h, { method: "POST", body })).json.code, code, JSON.stringify(body));
  }
});

test("with publishing disabled nothing on the site can change, though the list still reads", async () => {
  const h = routeHarness();
  await h.publisher.publish(post());
  process.env.PUBLISH_ENABLED = "false";
  try {
    for (const body of [{ postId: A }, { action: "unpublish", postId: A }, { action: "rebuild" }]) {
      assert.equal((await call(h, { method: "POST", body })).json.code, "publish_disabled", JSON.stringify(body));
    }
    assert.equal((await call(h)).status, 200);
  } finally {
    delete process.env.PUBLISH_ENABLED;
  }
  assert.deepEqual(Object.keys(await indexOf(h.store)), ["a-post"]);
  assert.equal(h.hooks.length, 0);
});

test("discarding a published post's draft through its route is a 409 that says what to do", async () => {
  const h = routeHarness();
  const { draft } = await h.drafts.create({ title: "Kept", date: "2026-07-01", body: "Live text." });
  await h.publisher.publish(draft);

  const res = fakeRes();
  await draftById({
    method: "DELETE", url: `/api/drafts/${draft.postId}/`, query: { id: draft.postId }, headers: await headersFor(h),
  }, res);
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.code, "post_published");
  assert.match(body.message, /Unpublish it/);
  assert.ok(await h.drafts.get(draft.postId));
});
