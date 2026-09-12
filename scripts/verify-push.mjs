// Exercises the staging push against the REAL bucket (CLAUDE.md §3.6, 6E).
//
//   node --env-file=.env scripts/verify-push.mjs
//
// Runs under a throwaway prefix and deletes everything it wrote, from R2 and
// from a temporary staging folder. The deploy hook is stubbed. Uses real signed
// URLs and real HTTP PUTs for every bundle file, so it proves what the unit
// tests' stand-in only imitates: that R2 accepts a bundle file on the URL the
// upload path signs, refuses one of another size, and serves back the bytes
// confirmation compares with the disk before deleting.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { createInteractives } from "../lib/server/interactives.mjs";
import { createPublisher, INDEX_KEY } from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { syncPublishedMedia } from "../lib/server/media-sync.mjs";
import { readStagedPost, createStagingPush, putToSignedUrl } from "../lib/server/staging.mjs";
import { loadR2Config } from "../lib/server/config.mjs";
import { probePrefix, cleanUpOnExit, sweepStaleProbes } from "./probe-prefix.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PNG = fs.readFileSync(path.join(ROOT, "test", "fixtures", "media", "sample-7x11.png"));

const config = { ...loadR2Config(), prefix: probePrefix("push") };
const store = createStore({ config });
const sweep = cleanUpOnExit(store, { label: config.prefix });
const abandoned = await sweepStaleProbes(config);
if (abandoned) console.log(`Removed ${abandoned} object(s) left by an earlier interrupted run.\n`);

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "verify-push-"));
process.once("exit", () => fs.rmSync(staging, { recursive: true, force: true }));
const dir = path.join(staging, "probe-post");

const SOURCE = "---\ntitle: Push probe\ndate: 2026-09-13\ntags: [probe]\n---\n" +
  "A lab:\n\n::demo[lab]\n\nA figure:\n\n::figure[figure]\n";
const LAB = {
  "index.html": "<!doctype html><title>lab</title><script type=module src=./lab.mjs></script>",
  "fallback.html": "<p>The lab, <strong>still</strong>.</p>",
  "lab.mjs": "import { g } from './lib/constants.mjs';\nexport const run = () => g;\n",
  "lib/constants.mjs": "export const g = 9.81;\n",
  "data.json": '{"points":[1,2,3]}',
};
const FIGURE = {
  "interactive.json": '{"entry":"chart.mjs"}',
  "chart.mjs": "export function mount(root) { root.textContent = 'chart'; }\n",
  "fallback.html": '<figure><img src="still.png" alt="A still chart" /></figure>',
  "still.png": PNG,
};
function writeTree(base, files) {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
    fs.writeFileSync(path.join(base, name), body);
  }
}
function stageAll() {
  writeTree(dir, { "post.md": SOURCE });
  writeTree(path.join(dir, "lab"), LAB);
  writeTree(path.join(dir, "figure"), FIGURE);
}

let transfers = 0;
let onHook = null;
const interactives = createInteractives(store);
const publisher = createPublisher(store, {
  interactives,
  fireDeployHook: async () => { await onHook?.(); return { stubbed: true }; },
});
const pusher = createStagingPush(store, {
  interactives,
  publisher,
  transfer: async (upload, bytes) => { transfers++; return putToSignedUrl(upload, bytes); },
});

const results = [];
const assert = (cond, message) => { if (!cond) throw new Error(message); };
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(` FAIL  ${name} — ${err?.message}`);
  }
}

console.log(`Pushing against real R2 under ${config.prefix}/\n`);

let first;

await check("a dry run writes nothing to R2", async () => {
  stageAll();
  const plan = await pusher.plan(readStagedPost(dir));
  assert(plan.draft === "create", `expected a new post, got ${plan.draft}`);
  assert((await store.listAll("")).length === 0, "the dry run wrote to the bucket");
});

await check("a staged post publishes over real signed PUTs, and staging is emptied", async () => {
  first = await pusher.push(readStagedPost(dir));
  assert(first.complete, `kept: ${JSON.stringify(first.kept)}`);
  assert(transfers === Object.keys(LAB).length + Object.keys(FIGURE).length - 1,
    `expected ${Object.keys(LAB).length + Object.keys(FIGURE).length - 1} transfers, got ${transfers}`);
  const entry = (await store.getJson(INDEX_KEY))?.data.posts?.["push-probe"];
  assert(entry?.revisionId === first.revisionId, "the index does not name the pushed revision");
  assert(!fs.existsSync(dir), "the staged folder survived a confirmed push");
});

await check("the build emits what was staged, byte for byte", async () => {
  const posts = await loadPublishedPosts({ store });
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "verify-push-dist-"));
  try {
    await syncPublishedMedia({ store, posts, distDir: dist });
    const post = posts.find((p) => p.slug === "push-probe");
    const lab = post.interactives.find((i) => i.kind === "demo");
    const figure = post.interactives.find((i) => i.kind === "figure");
    for (const [name, body] of Object.entries(LAB)) {
      const file = path.join(dist, "demos", "push-probe", "lab", lab.revisionId, name);
      assert(fs.readFileSync(file).equals(Buffer.from(body)), `${name} differs`);
    }
    for (const [name, body] of Object.entries(FIGURE)) {
      if (name === "interactive.json") continue;
      const file = path.join(dist, "assets", "figures", "push-probe", "figure", figure.revisionId, name);
      assert(fs.readFileSync(file).equals(Buffer.from(body)), `${name} differs`);
    }
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

await check("R2 refuses a bundle file of another size on its signed URL", async () => {
  // The control for the stand-in the unit tests use: the signature, not the
  // push, is what holds a signed URL to its agreed length.
  const changed = { ...LAB, "data.json": '{"points":[4,5,6]}' };
  const manifest = {
    kind: "demo", name: "control", entry: "index.html", fallback: "fallback.html",
    files: Object.entries(changed).map(([name, body]) => ({
      name, bytes: Buffer.byteLength(body), sha256: crypto.createHash("sha256").update(body).digest("hex"),
    })),
  };
  const agreed = await interactives.begin({ postId: first.postId, manifest });
  const upload = agreed.uploads.find((u) => u.name === "data.json");
  let refused = false;
  try {
    await putToSignedUrl(upload, Buffer.from('{"points":[4,5,6,7]}'));
  } catch {
    refused = true;
  }
  assert(refused, "R2 accepted a body longer than the signed length");
});

await check("a text-only re-push transfers nothing and uses the stored interactives", async () => {
  stageAll();
  fs.writeFileSync(path.join(dir, "post.md"), SOURCE.replace("A lab:", "A lab, again:"));
  transfers = 0;
  const again = await pusher.push(readStagedPost(dir));
  assert(again.complete, `kept: ${JSON.stringify(again.kept)}`);
  assert(transfers === 0, `${transfers} unchanged file(s) were transferred again`);
  assert(again.postId === first.postId, "a re-push made a second post");
  assert(again.revisionId !== first.revisionId, "the text change did not make a new revision");
});

await check("a file changed during the push is kept with its folder, then sent by the next push", async () => {
  stageAll();
  // New text, so publication really runs and the stubbed hook — which stands
  // in for the author saving during the push — fires between the commit point
  // and confirmation.
  fs.writeFileSync(path.join(dir, "post.md"), SOURCE.replace("A lab:", "A lab, a third time:"));
  onHook = () => fs.writeFileSync(path.join(dir, "lab", "data.json"), '{"points":[9]}');
  const stopped = await pusher.push(readStagedPost(dir));
  onHook = null;
  assert(!stopped.complete, "a changed file was deleted");
  assert(fs.existsSync(path.join(dir, "lab", "index.html")), "the changed folder was not kept whole");
  assert(fs.existsSync(path.join(dir, "post.md")), "the source was deleted while files were kept");

  const finished = await pusher.push(readStagedPost(dir));
  assert(finished.complete, `kept: ${JSON.stringify(finished.kept)}`);
  const post = (await loadPublishedPosts({ store })).find((p) => p.slug === "push-probe");
  const lab = post.interactives.find((i) => i.kind === "demo");
  const served = await store.get(`published/interactives/${first.postId}/${lab.id}/${lab.revisionId}/data.json`);
  assert(served?.body.toString() === '{"points":[9]}', "the change did not reach the published bundle");
  assert(!fs.existsSync(dir), "staging was not emptied");
});

console.log("\nCleaning up...");
console.log(`Deleted ${await sweep()} objects.`);
const stale = await sweepStaleProbes(config);
if (stale) console.log(`Also removed ${stale} object(s) left by an earlier interrupted run.`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} push checks passed`);
if (failed.length) process.exit(1);
