// Tier 3/7 — build-side media (CLAUDE.md §3.3, Step 6).
//
// "Fail the build loudly on a missing or corrupt asset rather than shipping a
// broken reference." A build that succeeds with a missing image is the failure
// mode being guarded: the site deploys, looks fine in the build log, and is
// broken for readers.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { keys } from "../lib/server/keys.mjs";
import { syncPublishedMedia, mediaJobs, MediaSyncError } from "../lib/server/media-sync.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const MEDIA = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "media");
const PNG = fs.readFileSync(path.join(MEDIA, "sample-7x11.png"));
const JPG = fs.readFileSync(path.join(MEDIA, "sample-13x5.jpg"));
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const POST = "p_00000000000000aa";

function harness() {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-media-"));
  return {
    client, store, dir,
    dist: path.join(dir, "dist"),
    cache: path.join(dir, "cache"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const post = (media, over = {}) => ({ slug: "a-post", postId: POST, media, ...over });
const entry = (publicName, bytes) => ({ publicName, sha256: sha(bytes), bytes: bytes.length });

test("every published image lands at its public path with exact bytes", async () => {
  const h = harness();
  try {
    await h.store.put(keys.media(POST, "diagram.png"), PNG);
    const stats = await syncPublishedMedia({ store: h.store, posts: [post([entry("diagram.png", PNG)])], distDir: h.dist });

    const written = fs.readFileSync(path.join(h.dist, "images", "uploads", "a-post", "diagram.png"));
    assert.ok(written.equals(PNG));
    assert.equal(stats.files, 1);
    assert.equal(stats.downloaded, 1);
    assert.equal(stats.bytes, PNG.length);
  } finally { h.cleanup(); }
});

test("a missing object stops the build instead of shipping a broken image", async () => {
  const h = harness();
  try {
    await assert.rejects(
      syncPublishedMedia({ store: h.store, posts: [post([entry("diagram.png", PNG)])], distDir: h.dist }),
      (err) => err instanceof MediaSyncError && /missing/.test(err.message)
    );
  } finally { h.cleanup(); }
});

test("an object that does not match its manifest stops the build", async () => {
  const h = harness();
  try {
    await h.store.put(keys.media(POST, "diagram.png"), JPG); // the wrong bytes under the right name
    await assert.rejects(
      syncPublishedMedia({ store: h.store, posts: [post([entry("diagram.png", PNG)])], distDir: h.dist }),
      (err) => err instanceof MediaSyncError && /does not match its manifest/.test(err.message)
    );
    assert.equal(fs.existsSync(path.join(h.dist, "images", "uploads", "a-post", "diagram.png")), false,
      "the mismatched file was written anyway");
  } finally { h.cleanup(); }
});

test("a warm cache avoids refetching, and a corrupt cache entry is refetched", async () => {
  const h = harness();
  try {
    await h.store.put(keys.media(POST, "diagram.png"), PNG);
    const posts = [post([entry("diagram.png", PNG)])];

    await syncPublishedMedia({ store: h.store, posts, distDir: h.dist, cacheDir: h.cache });
    const callsAfterCold = h.client.callCount;

    const warmDist = path.join(h.dir, "dist-2");
    const warm = await syncPublishedMedia({ store: h.store, posts, distDir: warmDist, cacheDir: h.cache });
    assert.equal(warm.cached, 1);
    assert.equal(warm.downloaded, 0);
    assert.equal(h.client.callCount, callsAfterCold, "a cached file was fetched from storage again");
    assert.ok(fs.readFileSync(path.join(warmDist, "images", "uploads", "a-post", "diagram.png")).equals(PNG));

    // A truncated cache entry must not be trusted.
    fs.writeFileSync(path.join(h.cache, sha(PNG)), PNG.subarray(0, 10));
    const repaired = await syncPublishedMedia({
      store: h.store, posts, distDir: path.join(h.dir, "dist-3"), cacheDir: h.cache,
    });
    assert.equal(repaired.downloaded, 1);
    assert.ok(fs.readFileSync(path.join(h.dir, "dist-3", "images", "uploads", "a-post", "diagram.png")).equals(PNG));
  } finally { h.cleanup(); }
});

test("a tampered manifest cannot write outside the site", () => {
  // Revisions come from R2, so their media entries are input, not trusted paths.
  const dist = path.join(os.tmpdir(), "never-written");
  for (const tampered of [
    post([{ publicName: "../../../evil.png", sha256: sha(PNG) }]),
    post([{ publicName: "evil.html", sha256: sha(PNG) }]),
    post([{ publicName: "diagram.png", sha256: "not-a-hash" }]),
    post([entry("diagram.png", PNG)], { slug: "../escape" }),
    post([entry("diagram.png", PNG)], { postId: undefined }),
  ]) {
    assert.throws(() => mediaJobs([tampered], dist), MediaSyncError,
      `accepted ${JSON.stringify(tampered)}`);
  }
});

test("posts without media never touch storage", async () => {
  const h = harness();
  try {
    const stats = await syncPublishedMedia({ store: null, posts: [post([]), { slug: "b", postId: POST }], distDir: h.dist });
    assert.equal(stats.files, 0);
  } finally { h.cleanup(); }
});

test("downloads run in parallel, but never more at once than the limit", async () => {
  const h = harness();
  try {
    const media = [];
    for (let i = 0; i < 12; i++) {
      const bytes = Buffer.concat([PNG, Buffer.from([i])]);
      await h.store.put(keys.media(POST, `f${i}.png`), bytes);
      media.push(entry(`f${i}.png`, bytes));
    }
    let active = 0;
    let peak = 0;
    const slow = {
      ...h.store,
      async get(key) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try { return await h.store.get(key); } finally { active--; }
      },
    };
    const stats = await syncPublishedMedia({ store: slow, posts: [post(media)], distDir: h.dist, concurrency: 3 });
    assert.equal(stats.downloaded, 12);
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
    assert.ok(peak > 1, "downloads ran one at a time");
  } finally { h.cleanup(); }
});
