// Tier 3 — publishing with attachments, end to end (CLAUDE.md §4.2, Step 6).
//
// Draft -> upload -> reference -> publish -> build reader -> media sync ->
// rendered page. Each stage has its own unit tests; this file exists because
// the defects that matter live at the joins — a reference resolved but its
// image never copied, an image copied but not named in the manifest the build
// reads.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads } from "../lib/server/uploads.mjs";
import { createPublisher, PublishError, INDEX_KEY, revisionKey } from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { syncPublishedMedia } from "../lib/server/media-sync.mjs";
import { keys } from "../lib/server/keys.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const MEDIA = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "media");
const PNG = fs.readFileSync(path.join(MEDIA, "sample-7x11.png"));
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function harness({ storeFor } = {}) {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  const uploads = createUploads(store, { signPut: async (key) => `https://signed.test/${key}` });
  const publishStore = storeFor ? storeFor(store) : store;
  return {
    client, store, uploads,
    drafts: createDraftStore(store),
    publisher: createPublisher(publishStore, { fireDeployHook: async () => ({}), uploads }),
  };
}

async function newDraft(h, title = "Media post") {
  const { draft } = await h.drafts.create({ title, date: "2026-09-11", body: "placeholder", format: "markdown" });
  return draft.postId;
}

async function attach(h, postId, bytes, { name, type = "image/png", kind = "image" }) {
  const signed = await h.uploads.sign({ postId, name, size: bytes.length, type, kind });
  await h.store.put(keys.upload(postId, signed.uploadId, "file"), bytes);
  return h.uploads.complete({ postId, uploadId: signed.uploadId });
}

async function withBody(h, postId, body) {
  const current = await h.drafts.get(postId);
  return (await h.drafts.save(postId, { body }, current.etag)).draft;
}

const revisionOf = async (h, draft) =>
  (await h.store.getJson(revisionKey(draft.postId, draft.revisionId)))?.data ?? null;

// ------------------------------------------------------------------ resolution

test("publishing freezes final image paths into the revision", async () => {
  const h = harness();
  const postId = await newDraft(h);
  const image = await attach(h, postId, PNG, { name: "diagram.png" });
  const draft = await withBody(h, postId, `Intro.\n\n![A diagram](attachment://${image.id})`);

  await h.publisher.publish(draft);
  const revision = await revisionOf(h, draft);

  assert.match(revision.body, /!\[A diagram\]\(\/images\/uploads\/media-post\/diagram\.png\)/);
  assert.ok(!revision.body.includes("attachment://"), "a draft-only reference leaked into the revision");
  assert.deepEqual(revision.media, [{
    id: image.id, publicName: "diagram.png", mediaType: "image/png",
    bytes: PNG.length, sha256: sha(PNG), width: 7, height: 11,
  }]);
});

test("every image is in place before the index names the revision", async () => {
  // The index update is the commit point; a build may start the moment it
  // lands. An image copied after it is an image a build can miss.
  const order = [];
  let mediaKey;
  const h = harness({
    storeFor: (store) => ({
      ...store,
      async createJson(key, data) {
        if (key === INDEX_KEY) order.push((await store.head(mediaKey)) ? "media, then index" : "index, then media");
        return store.createJson(key, data);
      },
    }),
  });
  const postId = await newDraft(h);
  const image = await attach(h, postId, PNG, { name: "diagram.png" });
  mediaKey = keys.media(postId, image.publicName);
  await h.publisher.publish(await withBody(h, postId, `![x](attachment://${image.id})`));

  assert.deepEqual(order, ["media, then index"]);
  assert.ok((await h.store.get(mediaKey)).body.equals(PNG));
});

test("a reference to an attachment the post does not have blocks publishing entirely", async () => {
  const h = harness();
  const postId = await newDraft(h);
  const draft = await withBody(h, postId, "![x](attachment://a_0000000000000999)");

  const err = await h.publisher.publish(draft).then(() => null, (e) => e);
  assert.ok(err instanceof PublishError);
  assert.equal(err.code, "unknown_attachment");
  assert.equal(await revisionOf(h, draft), null, "a revision was written for a post that cannot publish");
  assert.equal(await h.store.getJson(INDEX_KEY), null);
});

test("another post's attachment cannot be published into this one", async () => {
  const h = harness();
  const mine = await newDraft(h, "Mine");
  const theirs = await newDraft(h, "Theirs");
  const foreign = await attach(h, theirs, PNG, { name: "private.png" });

  const draft = await withBody(h, mine, `![stolen](attachment://${foreign.id})`);
  const err = await h.publisher.publish(draft).then(() => null, (e) => e);
  assert.equal(err?.code, "unknown_attachment");
  assert.equal(await h.store.get(keys.media(mine, "private.png")), null);
});

test("a .tex snippet is inlined, so the published revision needs no snippet file", async () => {
  const h = harness();
  const postId = await newDraft(h);
  const snippet = await attach(h, postId, Buffer.from("\\section{From a snippet}\nWith $x^2$."), {
    name: "part.tex", kind: "tex",
  });
  const draft = await withBody(h, postId, `Before.\n\n::tex[${snippet.id}]\n\nAfter.`);
  await h.publisher.publish(draft);

  const revision = await revisionOf(h, draft);
  assert.match(revision.body, /```tex-snippet/);
  assert.deepEqual(revision.media, []);

  const [rendered] = await loadPublishedPosts({ store: h.store });
  assert.match(rendered.html, /class="tex-snippet"/);
  assert.match(rendered.html, /From a snippet/);
  assert.match(rendered.html, /class="katex/);
});

test("an image reached only through a snippet is still copied and listed", async () => {
  // The body never names the image — the snippet does. Publishing copies what
  // resolution reports as used, so this is where a join could silently drop it.
  const h = harness();
  const postId = await newDraft(h);
  const image = await attach(h, postId, PNG, { name: "inner.png" });
  const snippet = await attach(h, postId, Buffer.from(`\\includegraphics{attachments/${image.id}.png}`), {
    name: "figure.tex", kind: "tex",
  });
  const draft = await withBody(h, postId, `::tex[${snippet.id}]`);
  await h.publisher.publish(draft);

  const revision = await revisionOf(h, draft);
  assert.deepEqual(revision.media.map((m) => m.publicName), ["inner.png"]);
  assert.ok(await h.store.get(keys.media(postId, "inner.png")), "the snippet's image was never copied");
});

// ------------------------------------------------------------------- the build

test("the build fetches exactly what the revision names, and the page shows it", async () => {
  const h = harness();
  const postId = await newDraft(h);
  const image = await attach(h, postId, PNG, { name: "diagram.png" });
  await h.publisher.publish(await withBody(h, postId, `![A diagram](attachment://${image.id})`));

  const posts = await loadPublishedPosts({ store: h.store });
  assert.equal(posts[0].media.length, 1);
  assert.match(posts[0].html, /<img src="\/images\/uploads\/media-post\/diagram\.png" alt="A diagram"/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-e2e-"));
  try {
    await syncPublishedMedia({ store: h.store, posts, distDir: dir });
    assert.ok(fs.readFileSync(path.join(dir, "images", "uploads", "media-post", "diagram.png")).equals(PNG));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a remote image in a browser-authored post is not rendered", async () => {
  const h = harness();
  const postId = await newDraft(h);
  await h.publisher.publish(await withBody(h, postId,
    "![tracking](https://evil.test/pixel.png)\n\n![sneaky](//evil.test/p.png)\n\n![slashy](/\\evil.test/p.png)"));

  const [rendered] = await loadPublishedPosts({ store: h.store });
  // The property is where a browser would send the request, judged by the same
  // URL parser browsers use — not whether an <img> tag exists. markdown-it
  // percent-encodes `/\evil.test` to `/%5Cevil.test`, a harmless path on this
  // site; a literal `/\evil.test` would have gone to evil.test.
  const SITE = "https://blog.souravmishra.net";
  for (const [, src] of rendered.html.matchAll(/<img[^>]+src="([^"]*)"/g)) {
    assert.equal(new URL(src, `${SITE}/media-post/`).origin, SITE, `an image loads from off-site: ${src}`);
  }
  assert.ok(!rendered.html.includes("evil.test/pixel.png\""), "the plainly remote image was rendered");
  assert.match(rendered.html, /tracking/, "the alt text should remain readable");
  assert.match(rendered.html, /sneaky/);
});

test("a post without attachments publishes exactly as before", async () => {
  const h = harness();
  const postId = await newDraft(h);
  const draft = await withBody(h, postId, "Just words, [and a link](https://example.com).");
  await h.publisher.publish(draft);

  const revision = await revisionOf(h, draft);
  assert.equal(revision.body, "Just words, [and a link](https://example.com).");
  assert.deepEqual(revision.media, []);
});
