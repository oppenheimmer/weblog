// Real HTTP failures, real cancellation clicks and a 24 MiB package in phone emulation.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { startEditorHarness, PASSWORD, sleep } from "./editor-harness.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createInteractives } from "../lib/server/interactives.mjs";
import { keys } from "../lib/server/keys.mjs";
import { postExportManifest } from "../lib/server/export.mjs";

let mode = "stall", calls = 0, closed = false;
const harness = await startEditorHarness({ requestHook(req, res, url) {
  if (req.method !== "GET" || url.searchParams.get("action") !== "export-file") return false;
  calls++;
  if (mode === "stall") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.from([1])); // Headers succeed; body consumption is still pending.
    res.on("close", () => { closed = true; });
    return true;
  }
  if (mode === "fail" || (mode === "retry" && calls === 1)) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Deliberate local interruption." }));
    return true;
  }
  return false;
} });
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function until(fn, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(20); }
  throw new Error("Timed out waiting for the browser or download.");
}

try {
  const drafts = createDraftStore(harness.store);
  const { draft } = await drafts.create({ title: "Large export", date: "2026-10-29", body: "Portable source." });
  const bundles = createInteractives(harness.store, { signPut: async () => "https://unused.test" });
  // Go through upload verification, not fabricated verified records. Each folder stays
  // within the real 10 MiB bundle and 5 MiB file limits.
  for (let i = 0; i < 3; i++) {
    const files = {
      "index.html": Buffer.from("<!doctype html><title>Export fixture</title>"),
      "fallback.html": Buffer.from("<p>Export fixture</p>"),
      "data/first.json": Buffer.from(JSON.stringify("a".repeat(4 * 1024 * 1024))),
      "data/second.json": Buffer.from(JSON.stringify("b".repeat(4 * 1024 * 1024))),
    };
    const begun = await bundles.begin({ postId: draft.postId, manifest: {
      kind: "demo", name: `large-${i}`, entry: "index.html", fallback: "fallback.html",
      files: Object.entries(files).map(([name, body]) => ({ name, bytes: body.length, sha256: hash(body) })),
    } });
    for (const [name, body] of Object.entries(files)) {
      await harness.store.put(keys.upload(draft.postId, begun.uploadId, `files/${name}`), body);
    }
    await bundles.complete({ postId: draft.postId, uploadId: begun.uploadId });
  }
  const manifest = await postExportManifest(harness.store, draft.postId);
  assert.ok(manifest.files.reduce((sum, f) => sum + f.bytes, 0) > 24 * 1024 * 1024);
  const page = await harness.openPage({ width: 390, height: 844 });
  const downloads = path.join(harness.work, "downloads");
  fs.mkdirSync(downloads);
  const archives = () => fs.readdirSync(downloads).filter((name) => name.endsWith(".zip"));
  await page.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, browserContextId: page.browserContextId });
  await page.goto(`${harness.SITE}/login/`);
  await page.type("#password", PASSWORD);
  await page.click("#login-submit");
  await page.until('location.pathname === "/editor/"');
  await page.clickText("#draft-list button", "Large export");
  await page.until('document.getElementById("body").value === "Portable source."');

  await page.click("#export-package");
  await until(() => calls > 0);
  await page.click("#export-cancel");
  await harness.check("Cancel aborts a stalled response body without retrying or downloading", async () => {
    await page.until('document.getElementById("export-note").textContent.startsWith("Export cancelled")');
    await until(() => closed);
    return calls === 1 && archives().length === 0 && await page.eval('document.getElementById("export-cancel").hidden');
  });

  mode = "fail"; calls = 0;
  await page.click("#export-package");
  await harness.check("persistent server errors stop after two retries and offer no partial archive", async () => {
    await page.until('document.getElementById("export-note").textContent.startsWith("Complete export stopped")');
    return calls === 3 && archives().length === 0;
  });
  await page.click("#export");
  await harness.check("source export still downloads after a failed complete export", async () => {
    await until(() => fs.readdirSync(downloads).some((name) => name.endsWith(".md")));
    return fs.readFileSync(path.join(downloads, fs.readdirSync(downloads).find((name) => name.endsWith(".md"))), "utf8").includes("Portable source.");
  });

  mode = "ok"; calls = 0;
  // Slow JS enough to deliver a real click during assembly, rather than invoking
  // the handler from test code or substituting a fake ZIP implementation.
  await page.call("Emulation.setCPUThrottlingRate", { rate: 12 });
  await page.click("#export-package");
  await until(() => page.eval('document.getElementById("export-note").textContent.startsWith("Creating ZIP")'));
  await page.click("#export-cancel");
  await harness.check("Cancel remains responsive during large ZIP assembly", async () => {
    await page.until('document.getElementById("export-note").textContent.startsWith("Export cancelled")');
    return archives().length === 0;
  });
  await page.call("Emulation.setCPUThrottlingRate", { rate: 1 });

  mode = "retry"; calls = 0;
  await page.click("#export-package");
  await harness.check("a recovered interruption produces a complete 24 MiB ZIP in phone emulation", async () => {
    await page.until('document.getElementById("export-note").textContent.startsWith("Exported saved")', 60_000);
    await until(() => archives().length === 1);
    const bytes = fs.readFileSync(path.join(downloads, archives()[0]));
    assert.ok(bytes.length > 24 * 1024 * 1024);
    // Independently read every stored ZIP entry and check the standard CRC,
    // expected file lengths and SHA-256s, including the virtual source files.
    const expected = new Map([
      ...manifest.files.map((f) => [f.path, f]),
      ...manifest.virtual.map((f) => [f.path, { bytes: Buffer.byteLength(f.text), sha256: hash(f.text) }]),
    ]);
    let offset = 0, entries = 0;
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
      const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
      const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
      const start = offset + 30 + nameLength + extra, data = bytes.subarray(start, start + size);
      const file = expected.get(name);
      assert.ok(file, name); assert.equal(size, file.bytes); assert.equal(hash(data), file.sha256);
      assert.equal(crc32(data), bytes.readUInt32LE(offset + 14));
      expected.delete(name); entries++; offset = start + size;
    }
    assert.equal(expected.size, 0);
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(bytes.length - 12), entries);
    return calls > 25;
  });
  await harness.check("phone export controls fit and the real page reports no script errors", async () =>
    await page.eval('document.documentElement.scrollWidth <= innerWidth + 1') && harness.scriptErrors.length === 0 && harness.serverErrors.length === 0);
} finally { await harness.shutdown(); }
harness.finish();
