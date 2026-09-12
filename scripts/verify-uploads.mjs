// Exercises the upload path against the REAL bucket (CLAUDE.md Step 4).
//
//   node --env-file=.env scripts/verify-uploads.mjs
//
// Runs under a throwaway prefix and deletes everything it wrote. The deploy
// hook is stubbed. Uses real presigned URLs and real HTTP PUTs, so it proves
// what the in-memory double cannot: that R2 honours the signature, including
// the signed content-type and content-length.
//
// The one thing Node cannot prove is a browser's CORS preflight. That is
// checked separately at the end and reported as pending rather than failed,
// because it depends on bucket settings made in the Cloudflare dashboard.
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads, UploadError } from "../lib/server/uploads.mjs";
import { createPublisher } from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { syncPublishedMedia } from "../lib/server/media-sync.mjs";
import { buildInventory } from "../lib/server/inventory.mjs";
import { keys, classifyKey } from "../lib/server/keys.mjs";
import { loadR2Config } from "../lib/server/config.mjs";
import { probePrefix, cleanUpOnExit, sweepStaleProbes } from "./probe-prefix.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PNG = fs.readFileSync(path.join(ROOT, "test", "fixtures", "media", "sample-7x11.png"));
// Same length as PNG, different content: a replay that the signed size permits.
const TAMPERED = Buffer.from(PNG);
TAMPERED[TAMPERED.length - 1] ^= 0xff;
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const SITE_ORIGIN = "https://blog.souravmishra.net";
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const config = { ...loadR2Config(), prefix: probePrefix("up") };
const store = createStore({ config });
// Cleanup no longer waits for the script to finish: Ctrl-C and an escaping
// exception both sweep this run's prefix on the way out (scripts/probe-prefix.mjs).
const sweep = cleanUpOnExit(store, { label: config.prefix });
// Debris an earlier interrupted run could not sweep itself. Older than an hour
// only, so a check running right now keeps its working set.
const abandoned = await sweepStaleProbes(config);
if (abandoned) console.log(`Removed ${abandoned} object(s) left by an earlier interrupted run.\n`);
const drafts = createDraftStore(store);
const uploads = createUploads(store);
const publisher = createPublisher(store, { fireDeployHook: async () => ({ stubbed: true }), uploads });

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

const put = (url, body, contentType) =>
  fetch(url, { method: "PUT", headers: { "content-type": contentType }, body });

console.log(`Uploading against real R2 under ${config.prefix}/\n`);

let postId;
let signed;
let record;

await check("a real presigned URL accepts the file it was signed for", async () => {
  ({ draft: { postId } } = await drafts.create({ title: "Upload probe", date: "2026-09-11", body: "x" }));
  signed = await uploads.sign({ postId, name: "Probe Diagram.png", size: PNG.length, type: "image/png" });
  assert(signed.url.includes("X-Amz-Signature"), "not a presigned URL");
  const res = await put(signed.url, PNG, "image/png");
  assert(res.ok, `PUT answered ${res.status}`);
});

await check("R2 refuses the same URL with a different content-type", async () => {
  // Proves the content-type really is part of the signature on R2 itself.
  const res = await put(signed.url, PNG, "text/html");
  assert(res.status === 403, `expected 403, got ${res.status}`);
});

await check("R2 refuses the same URL with a different size", async () => {
  // Proves content-length is part of the signature too, so a leaked URL cannot
  // be used to park an arbitrarily large object in the bucket.
  const res = await put(signed.url, Buffer.concat([PNG, Buffer.alloc(1024)]), "image/png");
  assert(res.status === 403, `expected 403, got ${res.status}`);
});

await check("completion verifies the bytes and promotes them", async () => {
  record = await uploads.complete({ postId, uploadId: signed.uploadId });
  assert(record.width === 7 && record.height === 11, `dimensions ${record.width}x${record.height}`);
  assert(record.sha256 === sha(PNG), "hash mismatch");
  assert(record.publicName === "probe-diagram.png", `name ${record.publicName}`);
  const blob = await store.get(record.key);
  assert(blob?.body.equals(PNG), "promoted bytes differ");
});

await check("replaying the still-valid URL cannot change the attachment", async () => {
  const res = await put(signed.url, TAMPERED, "image/png");
  assert(res.ok, `replay PUT answered ${res.status} (expected the URL to still accept same-size bytes)`);
  const again = await uploads.complete({ postId, uploadId: signed.uploadId });
  assert(again.sha256 === sha(PNG), "completion re-verified replayed bytes");
  const blob = await store.get(record.key);
  assert(blob.body.equals(PNG), "the verified attachment was replaced");
});

await check("a forged image is refused and nothing is promoted", async () => {
  const forged = await uploads.sign({ postId, name: "cute.png", size: SVG.length, type: "image/png" });
  const res = await put(forged.url, SVG, "image/png");
  assert(res.ok, `PUT answered ${res.status}`);
  let err;
  try { await uploads.complete({ postId, uploadId: forged.uploadId }); } catch (e) { err = e; }
  assert(err instanceof UploadError && err.code === "rejected", `expected rejected, got ${err?.code}`);
  const names = (await store.listAll(keys.attachmentPrefix(postId))).map((o) => o.key);
  assert(!names.some((k) => k.includes("cute")), "a forged file was promoted");
});

await check("publishing copies the image and freezes its public path", async () => {
  const current = await drafts.get(postId);
  const { draft } = await drafts.save(postId, { body: `![probe](attachment://${record.id})` }, current.etag);
  await publisher.publish(draft);
  const media = await store.get(keys.media(postId, record.publicName));
  assert(media?.body.equals(PNG), "published media missing or wrong");
});

await check("the build reads the revision, fetches the image, and verifies it", async () => {
  const posts = await loadPublishedPosts({ store });
  assert(posts.length === 1 && posts[0].media.length === 1, "manifest not carried to the build");
  assert(/<img src="\/images\/uploads\/upload-probe\/probe-diagram\.png"/.test(posts[0].html), "page lacks the image");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-verify-"));
  try {
    const stats = await syncPublishedMedia({ store, posts, distDir: dir });
    assert(stats.downloaded === 1, `downloaded ${stats.downloaded}`);
    const file = fs.readFileSync(path.join(dir, "images", "uploads", "upload-probe", "probe-diagram.png"));
    assert(file.equals(PNG), "built file differs");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("every object the upload path created is owned by its post", async () => {
  const objects = await store.listAll("");
  const stray = objects.filter(({ key }) => {
    const info = classifyKey(key);
    return info.kind === "unknown" || (info.owned && info.postId !== postId);
  });
  assert(stray.length === 0, `unowned or foreign keys: ${stray.map((o) => o.key).join(", ")}`);
  const tree = await buildInventory(store);
  const mine = tree.posts.find((p) => p.postId === postId);
  assert(mine?.attachments.length >= 3, "attachments missing from the inventory tree");
});

// ---- browser CORS (informational) -----------------------------------------

function preflight(url) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "OPTIONS",
      headers: {
        Origin: SITE_ORIGIN,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    }, (res) => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); });
    request.on("error", reject);
    request.end();
  });
}

// Guarded: if the first check failed there is no URL, and a throw here would
// skip the cleanup below and leave objects in the real bucket.
const cors = signed?.url
  ? await preflight(signed.url).catch((err) => ({ error: err.message }))
  : { error: "no signed URL (an earlier check failed)" };
const allowed = cors.headers?.["access-control-allow-origin"];
const corsReady = allowed === SITE_ORIGIN || allowed === "*";

// ---- cleanup ---------------------------------------------------------------
console.log("\nCleaning up...");
console.log(`Deleted ${await sweep()} objects.`);
// Debris from a run that was interrupted before it could tidy up. Older than
// an hour only, so a check running alongside this one keeps its working set.
const stale = await sweepStaleProbes(config);
if (stale) console.log(`Also removed ${stale} object(s) left by an earlier interrupted run.`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} upload checks passed`);
if (corsReady) {
  console.log(`Browser CORS preflight: ready (allow-origin ${allowed}).`);
} else {
  console.log(`Browser CORS preflight: PENDING — R2 answered ${cors.status ?? cors.error} ` +
    `without allowing ${SITE_ORIGIN}. Browser uploads stay blocked until the bucket has a CORS rule.`);
}
if (failed.length) process.exit(1);
