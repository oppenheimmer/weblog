// Tier 3 — a lab from reference to built site (CLAUDE.md §3.6, Slice 6C).
//
// The chain this covers is the one §4.2 insists on: a published revision is a
// self-contained document, so `::demo[<id>]` is resolved at publish time into
// a final public path and the build resolves nothing. What the build emits is
// checked against the bytes that were uploaded, because a bundle whose files
// were verified on the way in and corrupted afterwards must stop a build
// rather than ship.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createPublisher } from "../lib/server/publish.mjs";
import { createInteractives } from "../lib/server/interactives.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { syncPublishedMedia, interactiveJobs, MediaSyncError } from "../lib/server/media-sync.mjs";
import { keys } from "../lib/server/keys.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const FILES = {
  "index.html": "<!doctype html><title>orbit</title><script type=module src=./demo.mjs></script>",
  "fallback.html": "<p>Three planets, drawn <strong>still</strong>.</p>",
  "demo.mjs": "export const ready = true;\n",
  "data.json": '{"points":[1,2,3]}',
};

const manifest = (files = FILES, over = {}) => ({
  kind: "demo",
  name: "orbit",
  entry: "index.html",
  fallback: "fallback.html",
  files: Object.entries(files).map(([name, body]) => ({
    name, bytes: Buffer.byteLength(body), sha256: sha256(Buffer.from(body)),
  })),
  ...over,
});

async function harness() {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  const interactives = createInteractives(store, {
    signPut: async (key) => `https://signed.example/${encodeURIComponent(key)}`,
  });
  const drafts = createDraftStore(store);
  const publisher = createPublisher(store, { fireDeployHook: async () => ({}), interactives });
  return { store, client, interactives, drafts, publisher };
}

/** Upload one bundle and return its verified record. */
async function attach(h, postId, files = FILES, over = {}) {
  const agreed = await h.interactives.begin({ postId, manifest: manifest(files, over) });
  for (const [name, body] of Object.entries(files)) {
    await h.store.put(keys.upload(postId, agreed.uploadId, `files/${name}`), Buffer.from(body));
  }
  return h.interactives.complete({ postId, uploadId: agreed.uploadId });
}

/** The frozen revision as stored — the body the build reads, before rendering. */
async function storedRevision(h, postId) {
  const [published] = await loadPublishedPosts({ store: h.store });
  return (await h.store.getJson(keys.publishedRevision(postId, published.revisionId))).data;
}

/** A post with a saved draft, ready to have a bundle attached to it. */
async function newPost(h, slug = "a-post") {
  const { draft } = await h.drafts.create({ title: "A post", date: "2026-07-01", body: "seed" });
  return { postId: draft.postId, slug };
}

/** Save a body into an existing draft — the same post the bundle belongs to. */
async function saveBody(h, post, body) {
  const current = await h.drafts.get(post.postId);
  const saved = await h.drafts.save(post.postId, {
    ...current.draft, body, slug: post.slug, title: "A post", date: "2026-07-01",
  }, current.etag);
  return saved.draft;
}

// ------------------------------------------------------- resolution at publish

test("a lab reference becomes a final public path, frozen into the revision", async () => {
  const h = await harness();
  const post = await newPost(h);
  const bundle = await attach(h, post.postId);
  const ready = await saveBody(h, post, `Before.\n\n::demo[${bundle.id}]\n\nAfter.`);

  await h.publisher.publish(ready);
  const revision = await storedRevision(h, post.postId);

  assert.equal(revision.interactives.length, 1);
  assert.equal(revision.interactives[0].revisionId, bundle.revisionId);
  // No draft-only directive survives into what the build reads.
  assert.ok(!revision.body.includes("::demo["), "an unresolved directive was published");
  assert.match(revision.body, /\/demos\/a-post\/orbit\/iv_[0-9a-f]{16}\/index\.html/);
});

test("the rendered page carries the fallback, and the lab's address for the engine", async () => {
  const h = await harness();
  const post = await newPost(h);
  const bundle = await attach(h, post.postId);
  await h.publisher.publish(await saveBody(h, post, `::demo[${bundle.id}]`));
  const [published] = await loadPublishedPosts({ store: h.store });

  // What the build actually writes into the page, rendered by the same
  // pipeline the site uses — not a re-render of the source.
  const html = published.html;
  // The fallback is the content. No iframe is in the static HTML at all: the
  // engine adds it, on a post page only, so a listing runs nothing.
  assert.match(html, /<figure class="interactive" data-interactive="demo"/);
  assert.match(html, /Three planets, drawn <strong>still<\/strong>/);
  assert.ok(!/<iframe/i.test(html), "a published page shipped an iframe of its own");
  assert.match(html, /data-interactive-src="\/demos\/a-post\/orbit\/iv_[0-9a-f]{16}\/index\.html"/);
});

test("publishing refuses a reference to an interactive the post does not own", async () => {
  const h = await harness();
  const mine = await newPost(h, "mine");
  const theirs = await newPost(h, "theirs");
  const foreign = await attach(h, theirs.postId);

  // The id exists and is verified — for another post. §4.2 makes that a
  // refusal rather than "not found", so one post cannot publish another's.
  const ready = await saveBody(h, mine, `::demo[${foreign.id}]`);
  await assert.rejects(
    () => h.publisher.publish(ready),
    (err) => err.code === "unknown_interactive"
  );
});

test("a figure publishes to the assets tree, not the sandboxed one", async () => {
  const h = await harness();
  const post = await newPost(h);
  const figure = await attach(h, post.postId, {
    "main.mjs": "export const mount = () => {};\n",
    "fallback.html": "<p>A still chart.</p>",
  }, { kind: "figure", entry: "main.mjs", name: "loss-surface" });

  await h.publisher.publish(await saveBody(h, post, `::figure[${figure.id}]`));
  const revision = await storedRevision(h, post.postId);

  assert.equal(revision.interactives.length, 1);
  assert.equal(revision.interactives[0].kind, "figure");
  // The two pathways differ by prefix, which is what lets response headers
  // treat them differently: a lab is sandboxed, a figure is page code.
  assert.match(revision.body, /\/assets\/figures\/a-post\/loss-surface\/iv_[0-9a-f]{16}\/main\.mjs/);
  assert.ok(!revision.body.includes("/demos/"), "a figure was published under the lab prefix");
});

test("a figure and a lab can share a page without colliding", async () => {
  const h = await harness();
  const post = await newPost(h);
  const lab = await attach(h, post.postId);
  const figure = await attach(h, post.postId, {
    "main.mjs": "export const mount = () => {};\n",
    "fallback.html": "<p>A still chart.</p>",
  }, { kind: "figure", entry: "main.mjs", name: "loss-surface" });

  await h.publisher.publish(await saveBody(h, post, `::figure[${figure.id}]\n\n::demo[${lab.id}]`));
  const [published] = await loadPublishedPosts({ store: h.store });

  assert.equal(published.interactives.length, 2);
  // Each gets its own root or frame, and the figure's root id is derived from
  // its own public path, so two of them cannot share an id.
  assert.match(published.html, /class="interactive interactive--figure"/);
  assert.match(published.html, /id="figure-loss-surface-iv_[0-9a-f]{16}"/);
  assert.match(published.html, /data-interactive="demo"/);
  assert.ok(!/<iframe/i.test(published.html), "static HTML shipped a frame");
});

test("a figure declaring a library the engine does not serve is refused", async () => {
  const h = await harness();
  const post = await newPost(h);
  await assert.rejects(
    () => attach(h, post.postId, {
      "main.mjs": "export const mount = () => {};\n",
      "fallback.html": "<p>still</p>",
    }, { kind: "figure", entry: "main.mjs", dependencies: ["d3"] }),
    (err) => err.code === "invalid_dependency"
  );
});

test("a reference inside code is left alone", async () => {
  const h = await harness();
  const post = await newPost(h);
  const bundle = await attach(h, post.postId);
  const body = "A post explaining the syntax:\n\n```\n::demo[i_0000000000000000]\n```\n\n" +
    `And a real one:\n\n::demo[${bundle.id}]\n`;

  await h.publisher.publish(await saveBody(h, post, body));
  const revision = await storedRevision(h, post.postId);
  assert.ok(revision.body.includes("::demo[i_0000000000000000]"), "a code sample was rewritten");
  assert.equal(revision.interactives.length, 1);
});

test("a hostile fallback is refused, not cleaned", async () => {
  const h = await harness();
  const post = await newPost(h);
  const bundle = await attach(h, post.postId, {
    ...FILES,
    "fallback.html": '<p onclick="steal()">hello</p>',
  });

  const ready = await saveBody(h, post, `::demo[${bundle.id}]`);
  await assert.rejects(
    () => h.publisher.publish(ready),
    (err) => err.code === "fallback_refused"
  );
});

// --------------------------------------------------------------- the build

async function buildInto(h) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-demo-"));
  const posts = await loadPublishedPosts({ store: h.store });
  const stats = await syncPublishedMedia({ store: h.store, posts, distDir: dist });
  return { dist, posts, stats };
}

test("the build emits a bundle at its public path, byte for byte", async () => {
  const h = await harness();
  const post = await newPost(h);
  const bundle = await attach(h, post.postId);
  await h.publisher.publish(await saveBody(h, post, `::demo[${bundle.id}]`));

  const { dist, stats } = await buildInto(h);
  assert.equal(stats.bundleFiles, 4);
  for (const [name, body] of Object.entries(FILES)) {
    const file = path.join(dist, "demos", "a-post", "orbit", bundle.revisionId, name);
    assert.ok(fs.existsSync(file), `${name} was not emitted`);
    assert.equal(fs.readFileSync(file, "utf8"), body, `${name} was emitted with different bytes`);
  }
  // index.html says ./demo.mjs, so demo.mjs has to be its neighbour.
  assert.ok(fs.existsSync(path.join(dist, "demos", "a-post", "orbit", bundle.revisionId, "demo.mjs")));
  fs.rmSync(dist, { recursive: true, force: true });
});

test("the build emits a figure into the assets tree, beside its own files", async () => {
  const h = await harness();
  const post = await newPost(h);
  const files = {
    "main.mjs": "import { draw } from './lib/draw.mjs';\nexport const mount = draw;\n",
    "lib/draw.mjs": "export const draw = () => {};\n",
    "fallback.html": "<p>A still chart.</p>",
  };
  const figure = await attach(h, post.postId, files,
    { kind: "figure", entry: "main.mjs", name: "loss-surface" });
  await h.publisher.publish(await saveBody(h, post, `::figure[${figure.id}]`));

  const { dist } = await buildInto(h);
  const base = path.join(dist, "assets", "figures", "a-post", "loss-surface", figure.revisionId);
  for (const [name, body] of Object.entries(files)) {
    assert.equal(fs.readFileSync(path.join(base, name), "utf8"), body, name);
  }
  // main.mjs imports ./lib/draw.mjs, so that path has to survive intact.
  assert.ok(fs.existsSync(path.join(base, "lib", "draw.mjs")));
  assert.ok(!fs.existsSync(path.join(dist, "demos")), "a figure was emitted under the lab prefix");
  fs.rmSync(dist, { recursive: true, force: true });
});

test("a bundle file corrupted after publication stops the build", async () => {
  const h = await harness();
  const post = await newPost(h);
  const bundle = await attach(h, post.postId);
  await h.publisher.publish(await saveBody(h, post, `::demo[${bundle.id}]`));

  await h.store.put(
    keys.publishedInteractive(post.postId, bundle.id, bundle.revisionId, "demo.mjs"),
    Buffer.from("export const ready = false; // tampered\n")
  );
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-demo-"));
  const posts = await loadPublishedPosts({ store: h.store });
  await assert.rejects(
    () => syncPublishedMedia({ store: h.store, posts, distDir: dist }),
    MediaSyncError
  );
  fs.rmSync(dist, { recursive: true, force: true });
});

test("a tampered revision cannot make the build write outside the site", () => {
  // Revisions come from R2, so their manifests are input, not trusted paths.
  const post = { slug: "a-post", postId: "p_00000000000000aa" };
  const bundle = {
    id: "i_00000000000000b1", kind: "demo", name: "orbit",
    revisionId: "iv_00000000000000c1", entry: "index.html", fallback: "fallback.html",
  };
  for (const files of [
    [{ name: "../../escape.js", sha256: "a".repeat(64), bytes: 1 }],
    [{ name: "/etc/passwd", sha256: "a".repeat(64), bytes: 1 }],
    [{ name: "ok.js", sha256: "not-a-hash", bytes: 1 }],
  ]) {
    assert.throws(
      () => interactiveJobs([{ ...post, interactives: [{ ...bundle, files }] }], "/tmp/dist"),
      MediaSyncError,
      JSON.stringify(files[0].name)
    );
  }
  for (const broken of [{ name: "../evil" }, { revisionId: "r_not_a_bundle" }, { kind: "widget" }]) {
    assert.throws(
      () => interactiveJobs([{
        ...post,
        interactives: [{ ...bundle, ...broken, files: [{ name: "a.js", sha256: "a".repeat(64), bytes: 1 }] }],
      }], "/tmp/dist"),
      MediaSyncError,
      JSON.stringify(broken)
    );
  }
});

test("two publishes of the same content produce the same digest", async () => {
  const h = await harness();
  const post = await newPost(h);
  const bundle = await attach(h, post.postId);
  const ready = await saveBody(h, post, `::demo[${bundle.id}]`);

  const first = await h.publisher.publish(ready);
  await h.publisher.unpublish(post.postId);
  const second = await h.publisher.publish(ready, { idempotencyKey: "second" });
  assert.equal(second.digest, first.digest, "a bundle made publication non-deterministic");
});
