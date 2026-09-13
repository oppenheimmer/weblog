// Tier 3 and Tier 5 — the staging push (CLAUDE.md §3.6, Slice 6E).
//
// The promise is not "it uploads". It is that staging is a spool: a staged post
// reaches the site through the same services the editor uses, and afterwards
// the disk holds nothing of it — while a push that fails, or cannot confirm
// what it sent, deletes nothing it could not read back from R2. Most of these
// tests are about the second half.
//
// Uploads go over real HTTP to a stand-in for R2's signed URLs, which refuses a
// PUT of another size or type the way a signature does, so the push's own
// transfer code is what runs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createInteractives } from "../lib/server/interactives.mjs";
import { createPublisher, INDEX_KEY } from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { syncPublishedMedia } from "../lib/server/media-sync.mjs";
import { keys } from "../lib/server/keys.mjs";
import {
  readStagedPost, createStagingPush, stagedInteractiveId, StagingError,
} from "../lib/server/staging.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const PNG = fs.readFileSync(new URL("./fixtures/media/sample-7x11.png", import.meta.url));

const SOURCE = `---
title: Double pendulum
date: 2026-09-13
description: Chaos in two joints.
tags: [physics, simulation]
---
Two arms, one hinge each.

::demo[double-pendulum]

The energy stays put while everything else moves:

::figure[energy]

To embed one yourself, write this:

\`\`\`
::demo[your-folder]
\`\`\`
`;

const LAB = {
  "index.html": "<!doctype html><title>pendulum</title><script type=module src=./demo.mjs></script>",
  "fallback.html": "<p>A pendulum, drawn <strong>still</strong>.</p>",
  "demo.mjs": "import { step } from './lib/physics.mjs';\nexport const run = step;\n",
  "lib/physics.mjs": "export const step = (s) => s;\n",
  "data.json": '{"g":9.81}',
};

const FIGURE = {
  "interactive.json": JSON.stringify({ entry: "chart.mjs", dependencies: ["distill"] }),
  "chart.mjs": "export function mount(root) { root.textContent = 'energy'; }\n",
  "fallback.html": '<figure><img src="still.png" alt="Energy over time" /></figure>',
  "still.png": PNG,
};

/** Write a staged post folder and return its path. */
function stage(t, { source = SOURCE, name = "post.md", folders = { "double-pendulum": LAB, energy: FIGURE }, extra = {} } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-staging-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, "double-pendulum-post");
  writeTree(dir, { [name]: source, ...extra });
  for (const [folder, files] of Object.entries(folders)) writeTree(path.join(dir, folder), files);
  return { parent, dir };
}

function writeTree(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

/** Every file below a directory, relative, sorted. */
function listTree(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

async function harness(t, { failPut = () => false, fireDeployHook } = {}) {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });

  // Count what reaches storage, so "writes nothing" is measured, not assumed.
  const writes = [];
  const send = client.send.bind(client);
  client.send = (command) => {
    if (/Put|Delete|Copy/.test(command.constructor.name)) writes.push(command.input.Key);
    return send(command);
  };

  const signed = new Map();
  const puts = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const key = decodeURIComponent(new URL(req.url, "http://stand-in").pathname.slice(1));
    const agreed = signed.get(key);
    // What the signature enforces on R2: this key, this size, this type.
    if (req.method !== "PUT" || !agreed || agreed.contentLength !== body.length ||
        req.headers["content-type"] !== agreed.contentType) {
      res.writeHead(403).end();
      return;
    }
    if (failPut(key)) {
      res.writeHead(500).end();
      return;
    }
    await store.put(key, body, { contentType: agreed.contentType });
    puts.push(key);
    res.writeHead(200).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const interactives = createInteractives(store, {
    signPut: async (key, options) => {
      signed.set(key, options);
      return `${origin}/${encodeURIComponent(key)}`;
    },
  });
  const hooks = [];
  const publisher = createPublisher(store, {
    interactives,
    fireDeployHook: async () => {
      hooks.push(Date.now());
      return (await fireDeployHook?.({ store })) ?? {};
    },
  });
  const drafts = createDraftStore(store);
  const pusher = createStagingPush(store, { interactives, publisher, drafts });
  return { store, client, writes, puts, hooks, interactives, publisher, drafts, pusher };
}

const push = (h, dir, options) => h.pusher.push(readStagedPost(dir), options);

async function refusal(run, code) {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof StagingError, `threw a ${err.name}: ${err.message}`);
    if (code) assert.equal(err.code, code, err.message);
    return err;
  }
  assert.fail("the push was accepted");
}

async function indexEntry(h, slug = "double-pendulum") {
  return (await h.store.getJson(INDEX_KEY))?.data.posts?.[slug] ?? null;
}

// ------------------------------------------------------------ the whole path

test("a staged post and its folders are published, and the folder is left with nothing", async (t) => {
  const h = await harness(t);
  const { parent, dir } = stage(t);

  const result = await push(h, dir);

  assert.equal(result.complete, true, JSON.stringify(result.kept));
  assert.equal(result.kept.length, 0);
  // No trace: not a file, not a folder. The staging parent is the author's.
  assert.ok(!fs.existsSync(dir), "the staged folder is still there");
  assert.deepEqual(fs.readdirSync(parent), []);

  // One post, one rebuild, at the address its frontmatter implies.
  const entry = await indexEntry(h);
  assert.equal(entry.postId, result.postId);
  assert.equal(entry.revisionId, result.revisionId);
  assert.equal(h.hooks.length, 1);

  // The saved draft reads as one written in the editor: ids, not folder names,
  // and the code example untouched.
  const { draft } = await h.drafts.get(result.postId);
  const labId = stagedInteractiveId(result.postId, "double-pendulum");
  const figureId = stagedInteractiveId(result.postId, "energy");
  assert.match(draft.body, new RegExp(`::demo\\[${labId}\\]`));
  assert.match(draft.body, new RegExp(`::figure\\[${figureId}\\]`));
  assert.match(draft.body, /```\n::demo\[your-folder\]\n```/);
  assert.deepEqual(draft.tags, ["physics", "simulation"]);
  assert.equal(draft.date, "2026-09-13");

  // What the build emits is what was staged, byte for byte, at readable paths.
  const posts = await loadPublishedPosts({ store: h.store });
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-staging-dist-"));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  await syncPublishedMedia({ store: h.store, posts, distDir: dist });
  const [lab] = posts[0].interactives.filter((i) => i.kind === "demo");
  const [figure] = posts[0].interactives.filter((i) => i.kind === "figure");
  for (const [name, body] of Object.entries(LAB)) {
    const file = path.join(dist, "demos", "double-pendulum", "double-pendulum", lab.revisionId, name);
    assert.deepEqual(fs.readFileSync(file), Buffer.from(body), name);
  }
  for (const [name, body] of Object.entries(FIGURE)) {
    const file = path.join(dist, "assets", "figures", "double-pendulum", "energy", figure.revisionId, name);
    // The push's own config is not a bundle file, and is not published.
    if (name === "interactive.json") assert.ok(!fs.existsSync(file), "interactive.json was published");
    else assert.deepEqual(fs.readFileSync(file), Buffer.from(body), name);
  }
  assert.equal(figure.entry, "chart.mjs");
  assert.deepEqual(figure.dependencies, ["distill"]);
});

test("a dry run writes nothing and removes nothing", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t);
  const before = listTree(dir);

  const plan = await h.pusher.plan(readStagedPost(dir));

  assert.equal(plan.postId, null);
  assert.equal(plan.draft, "create");
  assert.deepEqual(plan.bundles.map((b) => [b.folder, b.kind, b.action]),
    [["double-pendulum", "demo", "upload"], ["energy", "figure", "upload"]]);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(listTree(dir), before);
});

test("a LaTeX post is pushed on its own", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t, {
    name: "note.tex",
    source: "---\ntitle: A note\ndate: 2026-09-13\n---\nEuler: $e^{i\\pi} + 1 = 0$.\n",
    folders: {},
  });

  const result = await push(h, dir);
  assert.equal(result.complete, true);
  assert.equal((await h.drafts.get(result.postId)).draft.format, "latex");
  assert.ok(await indexEntry(h, "a-note"));
  assert.ok(!fs.existsSync(dir));
});

// ------------------------------------------------- refused before any write

test("a file nothing sends is refused before anything is written", async (t) => {
  for (const extra of [{ "notes.txt": "todo" }, { ".DS_Store": "x" }, { "diagram.png": PNG }]) {
    const h = await harness(t);
    const { dir } = stage(t, { extra });
    const err = await refusal(() => push(h, dir), "unaccounted_files");
    assert.match(err.message, new RegExp(Object.keys(extra)[0].replace(".", "\\.")));
    assert.deepEqual(h.writes, [], `${Object.keys(extra)[0]}: something was written`);
    assert.ok(fs.existsSync(path.join(dir, "post.md")));
  }
});

test("an unreferenced folder is refused, however small", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t, { folders: { "double-pendulum": LAB, energy: FIGURE, old: { "a.js": "1" } } });
  const err = await refusal(() => push(h, dir), "unaccounted_files");
  assert.match(err.message, /old\/a\.js/);
  assert.deepEqual(h.writes, []);
});

test("a symbolic link is refused, not followed", async (t) => {
  const h = await harness(t);
  const { parent, dir } = stage(t);
  const outside = path.join(parent, "secret.txt");
  fs.writeFileSync(outside, "not for publication");
  fs.symlinkSync(outside, path.join(dir, "double-pendulum", "data-link.json"));

  await refusal(() => push(h, dir), "symlink");
  assert.deepEqual(h.writes, []);
  assert.equal(fs.readFileSync(outside, "utf8"), "not for publication");
});

test("frontmatter may not set engine hooks", async (t) => {
  const h = await harness(t);
  for (const hook of ["scripts: [/x.js]", "head: <script>1</script>", "distill: true", "draft: true"]) {
    const { dir } = stage(t, { source: `---\ntitle: A\ndate: 2026-09-13\n${hook}\n---\nBody.\n`, folders: {} });
    await refusal(() => push(h, dir), "frontmatter_refused");
  }
  assert.deepEqual(h.writes, []);
});

test("a reference that is not a plain folder name is refused", async (t) => {
  const h = await harness(t);
  for (const token of ["../escape", "a/b", ".hidden", ""]) {
    const { dir } = stage(t, { source: `---\ntitle: A\ndate: 2026-09-13\n---\n::demo[${token}]\n`, folders: {} });
    await refusal(() => push(h, dir), "invalid_reference");
  }
  assert.deepEqual(h.writes, []);
});

test("a folder the bundle contract refuses is refused before upload", async (t) => {
  const h = await harness(t);
  const cases = [
    [{ ...LAB, "extra.html": "<p>page</p>" }, "unexpected_html"],
    [{ ...LAB, "fallback.html": '<p onclick="x()">hi</p>' }, "fallback_refused"],
    [{ ...LAB, "picture.svg": "<svg/>" }, "unsupported_file"],
  ];
  for (const [files, code] of cases) {
    const { dir } = stage(t, { folders: { "double-pendulum": files, energy: FIGURE } });
    await refusal(() => push(h, dir), code);
  }
  const { dir } = stage(t, {
    folders: {
      "double-pendulum": LAB,
      energy: { ...FIGURE, "interactive.json": '{"entry":"chart.mjs","dependencies":["lodash"]}' },
    },
  });
  await refusal(() => push(h, dir), "invalid_dependency");
  assert.deepEqual(h.writes, []);
});

// ------------------------------------------- a failed push deletes nothing

test("a failed upload leaves every staged file in place", async (t) => {
  const h = await harness(t, { failPut: (key) => key.endsWith("/demo.mjs") });
  const { dir } = stage(t);
  const before = listTree(dir);

  await assert.rejects(() => push(h, dir), /Storage refused demo\.mjs/);
  assert.deepEqual(listTree(dir), before);
  assert.equal(await indexEntry(h), null, "a post went out with a failed upload");
});

test("a refused publish leaves every staged file in place, and the next push finishes it", async (t) => {
  const h = await harness(t);
  // An attachment id the post does not own: everything uploads, then
  // publication refuses, exactly as it would in the editor.
  const broken = SOURCE.replace("Two arms", "![x](attachment://a_0000000000000000)\n\nTwo arms");
  const { dir } = stage(t, { source: broken });
  const before = listTree(dir);

  await assert.rejects(() => push(h, dir), (err) => err.code === "unknown_attachment");
  assert.deepEqual(listTree(dir), before);
  assert.equal(await indexEntry(h), null);

  // The author fixes the source and pushes again: the same post, the same
  // interactives under the same names, nothing transferred twice.
  fs.writeFileSync(path.join(dir, "post.md"), SOURCE);
  const uploaded = h.puts.length;
  const result = await push(h, dir);
  assert.equal(result.complete, true, JSON.stringify(result.kept));
  assert.equal(h.puts.length, uploaded, "unchanged folders were transferred again");
  const records = await h.interactives.list(result.postId);
  assert.deepEqual(records.map((r) => r.name).sort(), ["double-pendulum", "energy"]);
  assert.ok(!fs.existsSync(dir));
});

// --------------------------------------------- confirmed means read back

test("a file changed during the push keeps its folder, and the source, for the next push", async (t) => {
  let dir;
  const h = await harness(t, {
    // After the commit point and before confirmation: the author saves a
    // change to the lab while the push is still running.
    fireDeployHook: () => fs.writeFileSync(path.join(dir, "double-pendulum", "demo.mjs"), "export const run = 2;\n"),
  });
  ({ dir } = stage(t));

  const first = await push(h, dir);
  assert.equal(first.complete, false);
  // The changed folder is whole, the confirmed one is gone, and the source
  // stays because there is still something to send.
  assert.deepEqual(listTree(path.join(dir, "double-pendulum")), Object.keys(LAB).map((n) => n.split("/").join(path.sep)).sort());
  assert.ok(!fs.existsSync(path.join(dir, "energy")), "a confirmed folder was kept");
  assert.ok(fs.existsSync(path.join(dir, "post.md")));
  assert.ok(first.kept.some((k) => /demo\.mjs changed on disk/.test(k.reason)));

  // Pushing again sends the change as a new revision of the same interactive,
  // uses the figure already on the post, and clears the folder.
  const second = await push(h, dir);
  assert.equal(second.complete, true, JSON.stringify(second.kept));
  const [published] = await loadPublishedPosts({ store: h.store });
  const lab = published.interactives.find((i) => i.kind === "demo");
  assert.equal(lab.id, stagedInteractiveId(first.postId, "double-pendulum"));
  assert.equal(lab.name, "double-pendulum");
  assert.ok(published.interactives.some((i) => i.kind === "figure"), "the figure was dropped");
  const served = await h.store.get(keys.publishedInteractive(first.postId, lab.id, lab.revisionId, "demo.mjs"));
  assert.equal(served.body.toString(), "export const run = 2;\n");
  assert.ok(!fs.existsSync(dir));
});

test("bytes R2 serves that differ from the disk are never grounds for deletion", async (t) => {
  let postId;
  const h = await harness(t, {
    // Corrupt the published copy after the commit point, before confirmation.
    fireDeployHook: async ({ store }) => {
      const [key] = (await store.listAll("published/interactives/")).map((o) => o.key)
        .filter((k) => k.endsWith("/data.json"));
      postId = key.split("/")[2];
      await store.put(key, Buffer.from('{"g":0}'));
    },
  });
  const { dir } = stage(t);

  const result = await push(h, dir);
  assert.equal(result.complete, false);
  assert.ok(postId);
  assert.ok(result.kept.some((k) => /R2 holds different bytes for double-pendulum\/data\.json/.test(k.reason)));
  assert.ok(fs.existsSync(path.join(dir, "double-pendulum", "data.json")));
  assert.ok(fs.existsSync(path.join(dir, "post.md")));
});

test("a post the index does not name as pushed keeps everything", async (t) => {
  const h = await harness(t, {
    // Someone unpublishes it between the commit point and confirmation.
    fireDeployHook: async ({ store }) => {
      await store.mutateJson(INDEX_KEY, (index) => ({ ...index, posts: {} }));
    },
  });
  const { dir } = stage(t);
  const before = listTree(dir);

  const result = await push(h, dir);
  assert.equal(result.removed.length, 0);
  assert.deepEqual(listTree(dir), before);
});

// ------------------------------------------------------------------ resuming

test("an interrupted cleanup is finished by pushing again, and publishes nothing new", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t);
  const first = await push(h, dir);
  const hooks = h.hooks.length;

  // What an interruption part way through deleting the lab leaves: the source,
  // and the lab without its entry and fallback, which go first.
  const { "index.html": _entry, "fallback.html": _fallback, ...rest } = LAB;
  writeTree(dir, { "post.md": SOURCE });
  writeTree(path.join(dir, "double-pendulum"), rest);

  const plan = await h.pusher.plan(readStagedPost(dir));
  assert.deepEqual(plan.bundles.map((b) => [b.folder, b.action]), [["double-pendulum", "finish"], ["energy", "reuse"]]);
  assert.equal(plan.draft, "unchanged");

  const second = await push(h, dir);
  assert.equal(second.complete, true, JSON.stringify(second.kept));
  assert.equal(second.revisionId, first.revisionId);
  assert.equal(h.hooks.length, hooks, "finishing a cleanup rebuilt the site");
  assert.ok(!fs.existsSync(dir));
});

test("removal that stops part way leaves a folder the next push finishes, never re-publishes", async (t) => {
  // unlink needs write permission on the directory, so a read-only
  // subdirectory stops removal at a real point, between files. Root ignores
  // permissions, and then this cannot stop anything.
  if (process.getuid?.() === 0) {
    t.skip("running as root, where a read-only directory does not stop removal");
    return;
  }
  const h = await harness(t);
  // Walk order is a/one.mjs, b/two.mjs, fallback.html, index.html. Removing
  // in that order would delete a/one.mjs and stop at b/, leaving a folder with
  // its entry and fallback but not all its files: a folder that looks like a
  // change, and would publish a lab missing a module.
  const lab = {
    "a/one.mjs": "export const one = 1;\n",
    "b/two.mjs": "export const two = 2;\n",
    "index.html": "<!doctype html><title>lab</title><script type=module src=./a/one.mjs></script>",
    "fallback.html": "<p>still</p>",
  };
  const { dir } = stage(t, {
    source: "---\ntitle: Double pendulum\ndate: 2026-09-13\n---\n::demo[lab]\n",
    folders: { lab },
  });
  const locked = path.join(dir, "lab", "b");
  fs.chmodSync(locked, 0o555);
  t.after(() => { if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755); });

  const first = await push(h, dir);
  assert.equal(first.complete, false);
  assert.ok(first.kept.some((k) => /lab\/b\/two\.mjs could not be removed/.test(k.reason)), JSON.stringify(first.kept));
  assert.ok(!fs.existsSync(path.join(dir, "lab", "index.html")), "the entry outlived a stopped removal");
  assert.ok(fs.existsSync(path.join(dir, "post.md")));

  fs.chmodSync(locked, 0o755);
  const plan = await h.pusher.plan(readStagedPost(dir));
  assert.deepEqual(plan.bundles.map((b) => b.action), ["finish"]);
  const hooks = h.hooks.length;
  const second = await push(h, dir);
  assert.equal(second.complete, true, JSON.stringify(second.kept));
  assert.equal(second.revisionId, first.revisionId);
  assert.equal(h.hooks.length, hooks);
  assert.ok(!fs.existsSync(dir));
});

test("an incomplete folder that is not the remainder of a push is refused", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t);
  await push(h, dir);

  writeTree(dir, { "post.md": SOURCE });
  const { "index.html": _entry, ...rest } = LAB;
  writeTree(path.join(dir, "double-pendulum"), { ...rest, "demo.mjs": "export const run = 3;\n" });

  const err = await refusal(() => h.pusher.plan(readStagedPost(dir)), "incomplete_bundle");
  assert.match(err.message, /index\.html/);
});

test("a source pushed alone uses the interactives its post already has", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t);
  const first = await push(h, dir);

  writeTree(dir, { "post.md": SOURCE.replace("Two arms, one hinge each.", "Two arms, two hinges.") });
  const plan = await h.pusher.plan(readStagedPost(dir));
  assert.deepEqual(plan.bundles.map((b) => b.action), ["reuse", "reuse"]);
  assert.equal(plan.draft, "save");

  const puts = h.puts.length;
  const second = await push(h, dir);
  assert.equal(second.complete, true);
  assert.equal(second.postId, first.postId);
  assert.notEqual(second.revisionId, first.revisionId);
  assert.equal(h.puts.length, puts);
  const [published] = await loadPublishedPosts({ store: h.store });
  assert.match(published.html, /two hinges/);
  assert.equal(published.interactives.length, 2);
});

test("an earlier revision of a folder is put back, and the site publishes it", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t);
  const first = await push(h, dir);
  const labId = (await h.interactives.list(first.postId)).find((record) => record.kind === "demo").id;
  const original = (await h.interactives.get(first.postId, labId)).revisionId;

  writeTree(dir, { "post.md": SOURCE });
  writeTree(path.join(dir, "double-pendulum"), { ...LAB, "demo.mjs": "export const run = 2;\n" });
  writeTree(path.join(dir, "energy"), FIGURE);
  await push(h, dir);
  assert.notEqual((await h.interactives.get(first.postId, labId)).revisionId, original);

  // Back to the first version: already stored, so nothing moves but the order.
  writeTree(dir, { "post.md": SOURCE });
  writeTree(path.join(dir, "double-pendulum"), LAB);
  writeTree(path.join(dir, "energy"), FIGURE);
  const plan = await h.pusher.plan(readStagedPost(dir));
  assert.equal(plan.bundles.find((bundle) => bundle.folder === "double-pendulum").action, "promote");
  const puts = h.puts.length;
  const third = await push(h, dir);

  assert.equal(third.complete, true, JSON.stringify(third.kept));
  assert.equal(h.puts.length, puts, "an earlier revision was transferred again");
  assert.equal((await h.interactives.get(first.postId, labId)).revisionId, original);
  const [published] = await loadPublishedPosts({ store: h.store });
  assert.equal(published.interactives.find((item) => item.id === labId).revisionId, original,
    "the site kept the newer revision");
});

test("an interactive the source stops naming is removed once the post is published", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t);
  const first = await push(h, dir);
  const energy = (await h.interactives.list(first.postId)).find((record) => record.kind === "figure");

  const withoutFigure = SOURCE.replace(/\nThe energy stays put[\s\S]*$/, "\n");
  assert.ok(!withoutFigure.includes("::figure"), "the fixture still names the figure");
  writeTree(dir, { "post.md": withoutFigure });
  writeTree(path.join(dir, "double-pendulum"), LAB);
  const plan = await h.pusher.plan(readStagedPost(dir));
  assert.deepEqual(plan.removals, [{ id: energy.id, kind: "figure", name: energy.name }]);

  const second = await push(h, dir);
  assert.equal(second.complete, true, JSON.stringify(second.kept));
  assert.deepEqual(second.removedInteractives.map(({ id }) => id), [energy.id]);
  assert.deepEqual((await h.interactives.list(first.postId)).filter((record) => record.id === energy.id), [],
    "the figure's stored revisions stayed");
  const [published] = await loadPublishedPosts({ store: h.store });
  assert.deepEqual(published.interactives.map((item) => item.kind), ["demo"]);
  // A rollback to the revision that used it still has what it serves, and the
  // name is never given to different bytes.
  assert.ok((await h.store.listAll(`published/interactives/${first.postId}/${energy.id}/`)).length > 0,
    "the published copy a rollback serves was removed");
  assert.ok(await h.store.get(keys.interactiveName(first.postId, energy.name)), "the name claim was removed");
});

test("a push refused at publication removes no interactive", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t);
  const first = await push(h, dir);
  const before = (await h.interactives.list(first.postId)).length;

  // Stops the figure being named, and names an image this post does not have,
  // which publishing refuses after the draft is saved.
  const refused = SOURCE.replace(/\nThe energy stays put[\s\S]*$/, "\n![gone](attachment://a_0000000000000000)\n");
  writeTree(dir, { "post.md": refused });
  writeTree(path.join(dir, "double-pendulum"), LAB);
  await assert.rejects(() => push(h, dir), (err) => err.code === "unknown_attachment");
  assert.equal((await h.interactives.list(first.postId)).length, before, "a refused push removed an interactive");
});

test("a folder name the post does not have is refused", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t, { folders: { energy: FIGURE } });
  await refusal(() => push(h, dir), "unknown_interactive");
  assert.deepEqual(h.writes, []);
});

// --------------------------------------------------------- whose draft is it

test("a draft with unpublished edits is not replaced without being told to", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t);
  const first = await push(h, dir);

  // The owner edits the draft in the browser and does not publish.
  const current = await h.drafts.get(first.postId);
  await h.drafts.save(first.postId, { body: "Rewritten in the editor." }, current.etag);

  writeTree(dir, { "post.md": SOURCE });
  const writes = h.writes.length;
  await refusal(() => push(h, dir), "draft_has_changes");
  assert.equal(h.writes.length, writes);
  assert.ok(fs.existsSync(path.join(dir, "post.md")));

  const replaced = await push(h, dir, { replaceDraft: true });
  assert.equal(replaced.complete, true);
  const history = await h.drafts.revisions(first.postId);
  assert.ok(history.length >= 3, "the editor's revision left the history");
});

test("a browser cannot mark a draft as the push's own", async (t) => {
  // The digest relaxes the push's refusal to replace a draft, so it must come
  // only from the push. The draft route hands its request body to save().
  const h = await harness(t);
  const created = await h.drafts.create({ title: "Double pendulum", body: "mine", pushedDigest: "forged" });
  assert.equal(created.draft.pushedDigest, undefined);
  const saved = await h.drafts.save(created.draft.postId, { body: "edited", pushedDigest: "forged" }, created.etag);
  assert.equal(saved.draft.pushedDigest, undefined);

  const { dir } = stage(t, { source: "---\ntitle: Double pendulum\ndate: 2026-09-13\n---\nPushed.\n", folders: {} });
  await refusal(() => push(h, dir), "draft_has_changes");
});

test("a published post with no draft is branched, keeping its id", async (t) => {
  const h = await harness(t);
  // A publication with no draft pointer, as migration left the welcome post.
  await h.publisher.publish({
    postId: "p_00000000000000aa", revisionId: "r_000001_000000000_aaaaaa", version: 1,
    title: "Double pendulum", date: "2026-01-01", slug: "double-pendulum",
    description: "", tags: [], format: "markdown", body: "The old text.",
  });
  const { dir } = stage(t, { source: "---\ntitle: Double pendulum\ndate: 2026-09-13\n---\nThe new text.\n", folders: {} });

  const plan = await h.pusher.plan(readStagedPost(dir));
  assert.equal(plan.postId, "p_00000000000000aa");
  assert.equal(plan.draft, "branch");

  const result = await push(h, dir);
  assert.equal(result.postId, "p_00000000000000aa");
  const [published] = await loadPublishedPosts({ store: h.store });
  assert.match(published.html, /The new text/);
});

test("two drafts at one address are refused until one is named", async (t) => {
  const h = await harness(t);
  const a = await h.drafts.create({ title: "Double pendulum", body: "one" });
  await h.drafts.create({ title: "Double pendulum", body: "two" });
  const { dir } = stage(t, { source: "---\ntitle: Double pendulum\ndate: 2026-09-13\n---\nChosen.\n", folders: {} });

  await refusal(() => push(h, dir), "ambiguous_post");
  const result = await push(h, dir, { postId: a.draft.postId, replaceDraft: true });
  assert.equal(result.postId, a.draft.postId);
});

test("another post's address is refused before anything is written", async (t) => {
  const h = await harness(t);
  const other = await h.drafts.create({ title: "Taken", date: "2026-09-01", body: "x", slug: "double-pendulum" });
  await h.publisher.publish(other.draft);
  const mine = await h.drafts.create({ title: "Mine", body: "y" });
  const { dir } = stage(t, { folders: {}, source: "---\ntitle: Double pendulum\ndate: 2026-09-13\n---\nText.\n" });

  const writes = h.writes.length;
  await refusal(() => push(h, dir, { postId: mine.draft.postId }), "slug_taken");
  assert.equal(h.writes.length, writes);
});

// ----------------------------------------------------------------- the script

test("the script refuses the engine itself, and a bad folder, before reading credentials", (t) => {
  const script = new URL("../scripts/push.mjs", import.meta.url).pathname;
  const root = path.resolve(path.dirname(script), "..");
  // No R2 variables at all: a refusal must not depend on reaching storage.
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH },
  });

  const engine = run(root, "--apply");
  assert.equal(engine.status, 1, engine.stderr);
  assert.match(engine.stderr, /is the engine/);

  const { dir } = stage(t, { extra: { "notes.txt": "todo" } });
  const stray = run(dir, "--apply");
  assert.equal(stray.status, 1, stray.stderr);
  assert.match(stray.stderr, /notes\.txt/);
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")));
});

test("a folder staged only as empty directories is tidied and nothing else", async (t) => {
  const h = await harness(t);
  const { dir } = stage(t, { source: SOURCE });
  fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "double-pendulum", "lib"), { recursive: true });

  const result = await push(h, dir);
  assert.equal(result.empty, true);
  assert.ok(!fs.existsSync(dir));
  assert.deepEqual(h.writes, []);
});
