import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads } from "../lib/server/uploads.mjs";
import { createInteractives } from "../lib/server/interactives.mjs";
import { keys } from "../lib/server/keys.mjs";
import { postExportManifest, exportFileChunk } from "../lib/server/export.mjs";
import { createZip, sourceDocument, verifyExportFile, exportRequest, EXPORT_CHUNK_BYTES } from "../assets/export.mjs";
import http from "node:http";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("complete export includes verified images, snippets and bundles, preserves source and refuses corrupt or foreign files", async () => {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const drafts = createDraftStore(store);
  const { draft } = await drafts.create({ title: "Export", date: "2026-10-29", slug: "explicit-address", body: "Original source" });
  const uploads = createUploads(store, { signPut: async () => "https://unused.test" });
  for (const [name, kind, type, bytes] of [
    ["image.png", "image", "image/png", fs.readFileSync(new URL("./fixtures/media/sample-7x11.png", import.meta.url))],
    ["equation.tex", "tex", "text/plain", Buffer.from("x^2")],
  ]) {
    const signed = await uploads.sign({ postId: draft.postId, name, kind, type, size: bytes.length });
    await store.put(keys.upload(draft.postId, signed.uploadId, "file"), bytes);
    await uploads.complete({ postId: draft.postId, uploadId: signed.uploadId });
  }
  const bundles = createInteractives(store, { signPut: async () => "https://unused.test" });
  const bytes = { "index.html": "<!doctype html><title>Lab</title>", "fallback.html": "<p>Fallback</p>", "nested/data.json": "{}" };
  const begun = await bundles.begin({ postId: draft.postId, manifest: { kind: "demo", name: "lab", entry: "index.html", fallback: "fallback.html",
    files: Object.entries(bytes).map(([name, body]) => ({ name, bytes: Buffer.byteLength(body), sha256: hash(Buffer.from(body)) })) } });
  for (const [name, body] of Object.entries(bytes)) await store.put(keys.upload(draft.postId, begun.uploadId, `files/${name}`), Buffer.from(body));
  await bundles.complete({ postId: draft.postId, uploadId: begun.uploadId });
  const manifest = await postExportManifest(store, draft.postId);
  assert.equal(manifest.files.length, 5);
  assert.ok(manifest.files.some((f) => f.path.endsWith("nested/data.json")));
  assert.ok(manifest.virtual.find((f) => f.path === "post.md").text.includes('slug: "explicit-address"'));
  const zipFiles = manifest.virtual.map((f) => ({ path: f.path, bytes: Buffer.from(f.text) }));
  for (const file of manifest.files) {
    const body = await exportFileChunk(store, draft.postId, file.token);
    await verifyExportFile(new Blob([body]), file);
    zipFiles.push({ path: file.path, bytes: body });
  }
  const zip = await createZip(zipFiles);
  assert.equal(zip.type, "application/zip");
  assert.ok(zip.size > 0);
  const other = await drafts.create({ title: "Other" });
  await assert.rejects(() => exportFileChunk(store, other.draft.postId, manifest.files[0].token), /no longer available/);
  await assert.rejects(() => exportFileChunk(store, draft.postId, manifest.files[0].token, -1), /Invalid export offset/);
  const attachment = (await uploads.list(draft.postId))[0];
  await store.put(keys.attachmentBlob(draft.postId, attachment.publicName), Buffer.alloc(attachment.bytes, 0));
  const file = manifest.files.find((f) => f.path.endsWith(attachment.publicName));
  await assert.rejects(() => exportFileChunk(store, draft.postId, file.token), /verification/);
});

test("exports include inherited publication assets and split large verified files into bounded responses", async () => {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const drafts = createDraftStore(store);
  const { draft } = await drafts.create({ title: "Inherited", date: "2026-10-29" });
  const bytes = Buffer.alloc(EXPORT_CHUNK_BYTES + 15, 7);
  const publication = { ...draft, media: [{ publicName: "large.png", bytes: bytes.length, sha256: hash(bytes) }], body: "![large](/images/uploads/inherited/large.png)" };
  await store.putJson(keys.publishedRevision(draft.postId, draft.revisionId), publication);
  await store.put(keys.media(draft.postId, "large.png"), bytes);
  await drafts.save(draft.postId, {}, (await drafts.get(draft.postId)).etag);
  // A publication-only post branches through the normal API once its old draft is absent.
  await store.delete(keys.draftPointer(draft.postId));
  await drafts.branchPublished(draft.postId, draft.revisionId);
  const manifest = await postExportManifest(store, draft.postId);
  const file = manifest.files[0];
  assert.equal((await exportFileChunk(store, draft.postId, file.token, 0)).length, EXPORT_CHUNK_BYTES);
  assert.equal((await exportFileChunk(store, draft.postId, file.token, EXPORT_CHUNK_BYTES)).length, 15);
  await verifyExportFile(new Blob([bytes]), file);
  await assert.rejects(() => verifyExportFile(new Blob([Buffer.alloc(bytes.length)]), file), /hash mismatch/);
});

test("source export preserves metadata and archive paths cannot escape or collide", async () => {
  assert.match(sourceDocument({ title: "a", tags: ["a,b"], slug: "chosen", body: "content" }), /tags: \["a,b"\]/);
  for (const path of ["../bad", "/absolute", "nested/../../bad", "a\\b"]) {
    await assert.rejects(() => createZip([{ path, bytes: new Uint8Array() }]), /Unsafe/);
  }
  await assert.rejects(() => createZip([{ path: "x", bytes: new Uint8Array() }, { path: "x", bytes: new Uint8Array() }]), /duplicate/);
});

test("export requests bound retries, include body reads in deadlines and respect cancellation", async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (req.url === "/retry" && calls < 3) { res.writeHead(503); res.end('{}'); return; }
    if (req.url === "/denied") { res.writeHead(401); res.end('{}'); return; }
    res.writeHead(200); res.flushHeaders();
    const timer = setTimeout(() => res.end("verified"), req.url === "/slow" ? 200 : 0);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bytes = await exportRequest(origin + "/retry");
  assert.equal(Buffer.from(bytes).toString(), "verified"); assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(() => exportRequest(origin + "/denied"), (e) => e.status === 401);
  assert.equal(calls, 1);
  await assert.rejects(() => exportRequest(origin + "/slow", { timeoutMs: 20, retries: 0 }), { name: "TimeoutError" });
  const controller = new AbortController();
  const reading = exportRequest(origin + "/slow", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => reading, { name: "AbortError" });
  const zipController = new AbortController();
  const zip = createZip([{ path: "large.bin", bytes: Buffer.alloc(8 * EXPORT_CHUNK_BYTES) }], { signal: zipController.signal });
  setTimeout(() => zipController.abort(), 0);
  await assert.rejects(() => zip, { name: "AbortError" });
});
