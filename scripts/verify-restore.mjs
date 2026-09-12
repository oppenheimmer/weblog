// Proves the content store can be rebuilt from a backup alone (CLAUDE.md Step 9).
//
//   node --env-file=.env scripts/verify-restore.mjs
//   node --env-file=.env scripts/verify-restore.mjs --keep    # leave the backup behind
//   node --env-file=.env scripts/verify-restore.mjs --control # damage the backup on purpose
//
// §1.1 removed Git as a second copy of the content, which makes the R2 backup
// the only one. A backup that has never been restored is not a backup, so this
// rehearses the whole procedure: seed realistic content, back it up with the
// same rclone command INSTALL documents, destroy the original, prove it is
// gone, restore, and rebuild. The proof is that the site built after the
// restore is byte-identical to the site built before the loss.
//
// Everything happens under throwaway prefixes on the real bucket. It refuses
// to run against prod.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createPublisher } from "../lib/server/publish.mjs";
import { createUploads } from "../lib/server/uploads.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { loadR2Config } from "../lib/server/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keepBackup = process.argv.includes("--keep");
// A restore rehearsal that cannot fail proves nothing. --control removes one
// file from the backup before restoring: the run then passes only if the
// checks notice.
const control = process.argv.includes("--control");

const base = loadR2Config();
const stamp = crypto.randomBytes(4).toString("hex");
const LIVE = `probe-restore-${stamp}`;        // stands in for prod/
const ELSEWHERE = `probe-restored-${stamp}`;  // restoring to a different prefix

// The one thing this script must never do.
for (const prefix of [LIVE, ELSEWHERE]) {
  if (/^prod/.test(prefix) || prefix === base.prefix && base.prefix === "prod") {
    console.error("Refusing to run against a production prefix.");
    process.exit(2);
  }
}

const store = createStore({ config: { ...base, prefix: LIVE } });
const drafts = createDraftStore(store);
const uploads = createUploads(store, { signPut: async (key) => `https://unused/${key}` });
const publisher = createPublisher(store, { fireDeployHook: async () => ({ stubbed: true }) });

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

// rclone reads its remote from the environment, so no config file is written
// and no credential is ever printed or left on disk.
const rcloneEnv = {
  ...process.env,
  RCLONE_CONFIG_R2_TYPE: "s3",
  RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
  RCLONE_CONFIG_R2_ACCESS_KEY_ID: base.accessKeyId,
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: base.secretAccessKey,
  RCLONE_CONFIG_R2_ENDPOINT: base.endpoint,
  RCLONE_CONFIG_R2_REGION: "auto",
  RCLONE_CONFIG_R2_NO_CHECK_BUCKET: "true",
};
const rclone = (...args) =>
  execFileSync("rclone", args, { env: rcloneEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Build the site from one prefix, exactly as a deployment does. */
function buildFrom(prefix, dist) {
  // The media cache is content-addressed and survives between builds, so it
  // would happily serve an image the restore never brought back. Clearing it
  // forces the verification build to fetch every byte from R2 again.
  fs.rmSync(path.join(ROOT, "node_modules", ".cache", "weblog-media"), { recursive: true, force: true });
  const run = spawnSync(process.execPath, ["build.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, R2_PREFIX: prefix, BLOG_DIST_DIR: dist, BLOG_POSTS_DIR: "" },
  });
  if (run.status !== 0) throw new Error(`build failed for ${prefix}: ${run.stderr?.trim().slice(0, 300)}`);
  return run.stdout;
}

/** Every emitted file and its hash, so two builds can be compared exactly. */
function fingerprint(dist) {
  const files = {};
  const walk = (dir, rel = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      entry.isDirectory() ? walk(full, key) : (files[key] = sha(fs.readFileSync(full)));
    }
  };
  walk(dist);
  return files;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-restore-"));
const backupDir = path.join(work, `backup-${new Date().toISOString().slice(0, 10)}`);
const distBefore = path.join(work, "dist-before");
const distAfter = path.join(work, "dist-after");

console.log(`Rehearsing backup and restore under ${LIVE}/ (bucket ${base.bucket})\n`);

// ---- 1. content worth losing ------------------------------------------------

const PNG = fs.readFileSync(path.join(ROOT, "test", "fixtures", "media", "sample-7x11.png"));
let liveKeys = [];

await check("seed: two published posts, one with an image, plus a draft and history", async () => {
  const a = await drafts.create({ title: "Restore me", date: "2026-07-01", body: "first", slug: "restore-me" });
  const pending = await uploads.sign({
    postId: a.draft.postId, name: "diagram.png", size: PNG.length, type: "image/png",
  });
  await store.put(`uploads/${a.draft.postId}/${pending.uploadId}/file`, PNG);
  const image = await uploads.complete({ postId: a.draft.postId, uploadId: pending.uploadId });

  // Publish once, then again, so the backup contains a superseded revision too.
  const first = await drafts.save(a.draft.postId,
    { ...a.draft, body: "First body." }, a.etag);
  await publisher.publish(first.draft);
  const second = await drafts.save(a.draft.postId,
    { ...first.draft, body: `Second body.\n\n![a diagram](attachment://${image.id})` }, first.etag);
  await publisher.publish(second.draft);

  const b = await drafts.create({ title: "Second post", date: "2026-07-02", body: "Another.", slug: "second-post" });
  await publisher.publish(b.draft);

  // An unpublished draft: it must survive a restore as well.
  await drafts.create({ title: "Still writing", date: "2026-07-03", body: "unfinished" });

  const posts = await loadPublishedPosts({ store });
  assert(posts.length === 2, `expected 2 published posts, got ${posts.length}`);
  liveKeys = (await store.listAll("")).map((o) => o.key);
  assert(liveKeys.length > 8, `expected a realistic object tree, got ${liveKeys.length}`);
});

// ---- 2. the site as it stands ----------------------------------------------

let before;
await check("build the site before any loss", async () => {
  buildFrom(LIVE, distBefore);
  before = fingerprint(distBefore);
  const manifest = JSON.parse(fs.readFileSync(path.join(distBefore, "build-manifest.json"), "utf8"));
  assert(manifest.posts.length === 2, `the build named ${manifest.posts.length} posts`);
  assert(fs.existsSync(path.join(distBefore, "restore-me", "index.html")), "the post page was not written");
  assert(fs.existsSync(path.join(distBefore, "images", "uploads", "restore-me", "diagram.png")),
    "the published image was not written");
});

// ---- 3. back it up, the documented way -------------------------------------

await check("rclone copies the whole prefix to a dated local directory", async () => {
  rclone("copy", `R2:${base.bucket}/${LIVE}`, backupDir, "--transfers", "8");
  const backedUp = [];
  const walk = (dir, rel = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const key = rel ? `${rel}/${e.name}` : e.name;
      e.isDirectory() ? walk(full, key) : backedUp.push(key);
    }
  };
  walk(backupDir);
  assert(backedUp.length === liveKeys.length,
    `backed up ${backedUp.length} of ${liveKeys.length} objects`);
});

await check("every backed-up byte matches the object it came from", async () => {
  for (const key of liveKeys) {
    const local = path.join(backupDir, key);
    assert(fs.existsSync(local), `missing from the backup: ${key}`);
    const source = await store.get(key);
    assert(source, `the object vanished while backing up: ${key}`);
    assert(sha(fs.readFileSync(local)) === sha(source.body), `bytes differ for ${key}`);
  }
});

await check("the backup is readable without this application", async () => {
  // A published revision is a self-contained JSON document, so an operator with
  // only the backup can still read what was published.
  const revision = fs.readdirSync(path.join(backupDir, "published", "posts"), { recursive: true })
    .map((p) => path.join(backupDir, "published", "posts", String(p)))
    .find((p) => p.endsWith(".json") && fs.statSync(p).isFile());
  const doc = JSON.parse(fs.readFileSync(revision, "utf8"));
  assert(doc.title && doc.body && doc.slug, "a published revision is not self-describing");
  assert(Array.isArray(doc.media), "a published revision carries no media manifest");
});

if (control) {
  const media = path.join(backupDir, "published", "media");
  const victim = fs.readdirSync(media, { recursive: true })
    .map((p) => path.join(media, String(p)))
    .find((p) => fs.statSync(p).isFile());
  fs.rmSync(victim);
  console.log(`\n  (control) deleted ${path.relative(backupDir, victim)} from the backup;`);
  console.log("  (control) the restore checks below must now fail\n");
}

// ---- 4. lose everything -----------------------------------------------------

await check("destroy the live prefix, and confirm the site is genuinely gone", async () => {
  for (const key of liveKeys) await store.delete(key);
  assert((await store.listAll("")).length === 0, "objects survived the deletion");

  const empty = path.join(work, "dist-empty");
  buildFrom(LIVE, empty);
  const manifest = JSON.parse(fs.readFileSync(path.join(empty, "build-manifest.json"), "utf8"));
  assert(manifest.posts.length === 0, "the build still found posts after the store was emptied");
  assert(!fs.existsSync(path.join(empty, "restore-me", "index.html")), "the post page survived the loss");
});

// ---- 5. restore -------------------------------------------------------------

await check("rclone restores the backup into a different prefix", async () => {
  // A different prefix on purpose: a real recovery may go to a new bucket, and
  // nothing in the data may depend on where it used to live.
  rclone("copy", backupDir, `R2:${base.bucket}/${ELSEWHERE}`, "--transfers", "8");
  const restored = createStore({ config: { ...base, prefix: ELSEWHERE } });
  const keys = (await restored.listAll("")).map((o) => o.key);
  assert(keys.length === liveKeys.length, `restored ${keys.length} of ${liveKeys.length} objects`);
});

await check("the rebuilt site is byte-identical to the site before the loss", async () => {
  buildFrom(ELSEWHERE, distAfter);
  const after = fingerprint(distAfter);
  const missing = Object.keys(before).filter((f) => !(f in after));
  const extra = Object.keys(after).filter((f) => !(f in before));
  const changed = Object.keys(before).filter((f) => after[f] && after[f] !== before[f]);
  assert(!missing.length, `missing after restore: ${missing.slice(0, 5).join(", ")}`);
  assert(!extra.length, `unexpected after restore: ${extra.slice(0, 5).join(", ")}`);
  assert(!changed.length, `changed after restore: ${changed.slice(0, 5).join(", ")}`);
  assert(Object.keys(after).length > 10, `only ${Object.keys(after).length} files were emitted`);
});

await check("the restored image is byte-identical, not merely present", async () => {
  const original = path.join(distBefore, "images", "uploads", "restore-me", "diagram.png");
  const restored = path.join(distAfter, "images", "uploads", "restore-me", "diagram.png");
  assert(sha(fs.readFileSync(restored)) === sha(fs.readFileSync(original)), "the image came back different");
  assert(sha(fs.readFileSync(restored)) === sha(PNG), "the image is not the one that was uploaded");
});

await check("drafts and superseded revisions came back too, not just what was live", async () => {
  const restored = createStore({ config: { ...base, prefix: ELSEWHERE } });
  const keys = (await restored.listAll("")).map((o) => o.key);
  assert(keys.some((k) => /^drafts\/.*\/current\.json$/.test(k)), "no draft pointer was restored");
  const revisions = keys.filter((k) => /^published\/posts\//.test(k));
  assert(revisions.length >= 3, `expected the superseded revision too, found ${revisions.length}`);
});

// ---- cleanup ----------------------------------------------------------------

console.log("\nCleaning up...");
let removed = 0;
for (const prefix of [LIVE, ELSEWHERE]) {
  const s = createStore({ config: { ...base, prefix } });
  for (const { key } of await s.listAll("")) { await s.delete(key); removed++; }
}
console.log(`Deleted ${removed} objects from the two throwaway prefixes.`);
if (keepBackup) {
  console.log(`Backup kept at ${backupDir}`);
  fs.rmSync(distBefore, { recursive: true, force: true });
  fs.rmSync(distAfter, { recursive: true, force: true });
} else {
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} restore checks passed`);

if (control) {
  // Inverted: a damaged backup must be caught, or the whole rehearsal is theatre.
  const noticed = results.some((r) => !r.ok &&
    /rebuilt site is byte-identical|restored image is byte-identical/.test(r.name));
  console.log(noticed
    ? "\nControl passed: a backup missing one file did not restore clean, so these checks can fail."
    : "\nCONTROL FAILED: a damaged backup restored clean. These checks prove nothing.");
  process.exit(noticed ? 0 : 1);
}

if (failed.length) process.exit(1);
