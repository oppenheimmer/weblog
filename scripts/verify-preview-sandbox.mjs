// Proves, in a real browser, what the preview frame can and cannot do
// (CLAUDE.md §3.1, Step 5).
//
//   node scripts/verify-preview-sandbox.mjs
//   CHROMIUM=/path/to/chrome node scripts/verify-preview-sandbox.mjs
//
// Serves a local stand-in for the editor with the editor's real CSP and the
// preview frame's real attributes (read from the editor markup), loads a real
// server-rendered preview into it, and watches which requests arrive — the
// servers' logs are the oracle, so nothing depends on reaching into the frame.
//
// Script is also *injected* into the rendered preview, simulating a sanitizer
// failure, to show the sandbox is a second lock rather than a redundant one. A
// control run without the sandbox attribute must show that injected script
// running and reaching the editor; if it does not, the check proves nothing
// and says so.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHROMIUM, BASE_FLAGS, EXTRA_FLAGS } from "./chromium.mjs";
import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads } from "../lib/server/uploads.mjs";
import { createPreviewer } from "../lib/server/preview.mjs";
import { editorPage, editorCsp } from "../lib/server/pages.mjs";
import { keys } from "../lib/server/keys.mjs";
import { createFakeS3, FAKE_CONFIG } from "../test/helpers/fake-r2.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EDITOR_PORT = 8821;
const STORAGE_PORT = 8822;
const STORAGE = `http://127.0.0.1:${STORAGE_PORT}`;
const PNG = fs.readFileSync(path.join(ROOT, "test", "fixtures", "media", "sample-7x11.png"));

// ---- a real preview, rendered by the real previewer --------------------------

const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
const uploads = createUploads(store, { signPut: async (key) => `https://unused/${key}` });
const { draft } = await createDraftStore(store).create({ title: "Sandbox probe", date: "2026-09-11", body: "x" });
const pending = await uploads.sign({ postId: draft.postId, name: "probe.png", size: PNG.length, type: "image/png" });
await store.put(keys.upload(draft.postId, pending.uploadId, "file"), PNG);
const image = await uploads.complete({ postId: draft.postId, uploadId: pending.uploadId });

const previewer = createPreviewer(store, {
  uploads,
  signGet: async (key) => `${STORAGE}/signed/${encodeURIComponent(key)}?X-Amz-Expires=600&X-Amz-Signature=probe`,
});
const { html } = await previewer.render({
  title: "Sandbox probe", date: "2026-09-11", postId: draft.postId,
  body: `Inline maths $e^{i\\pi} + 1 = 0$.\n\n![probe](attachment://${image.id})`,
});

// What a sanitizer failure would let through.
const injected = html.replace("</body>", `
<script>fetch('/hit/inline-script'); try { parent.document.title = 'pwned'; } catch (e) {}</script>
<script src="/probe/external.js"></script>
<img src="x" onerror="fetch('/hit/onerror')">
<span style="background:url(${STORAGE}/hit/style-attr.png)">styled</span>
</body>`);

// The frame exactly as the editor ships it.
const frameTag = editorPage().match(/<iframe\b[^>]*\bid="preview-frame"[^>]*>/)?.[0];
const sandbox = frameTag?.match(/\bsandbox="([^"]*)"/)?.[1];
if (sandbox === undefined) {
  console.log("FAIL  the editor's preview frame has no sandbox attribute");
  process.exit(1);
}
const csp = editorCsp({ upload: STORAGE, preview: true });

// ---- servers ---------------------------------------------------------------

const hits = [];
const attr = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
let withSandbox = true;

const files = {
  "/styles/blog.css": path.join(ROOT, "assets", "styles", "blog.css"),
  "/styles/katex.min.css": path.join(ROOT, "node_modules", "katex", "dist", "katex.min.css"),
  "/assets/blog.js": path.join(ROOT, "assets", "blog.js"),
};
const types = { ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };

const editor = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  if (pathname === "/") {
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": csp });
    return res.end(`<!doctype html><title>clean</title>
<iframe ${withSandbox ? `sandbox="${sandbox}"` : ""} referrerpolicy="no-referrer" srcdoc="${attr(injected)}"></iframe>`);
  }
  hits.push(`editor ${pathname}`);
  if (pathname === "/probe/external.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end("fetch('/hit/external-script'); try { parent.document.title = 'pwned'; } catch (e) {}");
  }
  const file = files[pathname] ??
    (pathname.startsWith("/styles/fonts/")
      ? path.join(ROOT, "node_modules", "katex", "dist", "fonts", path.basename(pathname))
      : null);
  if (file && fs.existsSync(file)) {
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(pathname.startsWith("/hit/") ? 204 : 404);
  res.end();
});
const storage = http.createServer((req, res) => {
  hits.push(`storage ${new URL(req.url, "http://x").pathname}`);
  res.writeHead(200, { "content-type": "image/png" });
  res.end(PNG);
});
await new Promise((resolve) => editor.listen(EDITOR_PORT, "127.0.0.1", resolve));
await new Promise((resolve) => storage.listen(STORAGE_PORT, "127.0.0.1", resolve));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-chrome-"));
function load() {
  hits.length = 0;
  return new Promise((resolve) => execFile(CHROMIUM, [
    ...BASE_FLAGS, `--user-data-dir=${profile}`, ...EXTRA_FLAGS,
    "--virtual-time-budget=6000", "--dump-dom", `http://127.0.0.1:${EDITOR_PORT}/`,
  ], { timeout: 90_000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
}

const results = [];
const check = (name, ok) => {
  results.push(ok);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
};
const hit = (entry) => hits.includes(entry);
const hitPrefix = (prefix) => hits.some((h) => h.startsWith(prefix));
const titleOf = (dom) => dom.match(/<title>([^<]*)<\/title>/)?.[1];

console.log(`Preview frame as shipped: sandbox="${sandbox}"\n`);

const sandboxed = await load();
if (sandboxed.err && !sandboxed.stdout) {
  console.log(`Could not run ${CHROMIUM}: ${String(sandboxed.stderr || sandboxed.err).slice(0, 300)}`);
  process.exit(2);
}
console.log("With the editor's sandbox:");
check("the preview renders with the site's stylesheets", hit("editor /styles/katex.min.css") && hit("editor /styles/blog.css"));
check("KaTeX fonts load (font-src 'self')", hitPrefix("editor /styles/fonts/"));
check("the attachment loads from storage on its signed URL", hitPrefix("storage /signed/"));
check("inline style attributes apply, which KaTeX layout needs", hit("storage /hit/style-attr.png"));
check("injected inline script does not run", !hit("editor /hit/inline-script"));
check("injected same-origin script does not run", !hit("editor /hit/external-script"));
check("injected event handler does not run", !hit("editor /hit/onerror"));
check("the editor page is untouched", titleOf(sandboxed.stdout) === "clean");

withSandbox = false;
const control = await load();
console.log("\nControl, same page without the sandbox attribute:");
check("the injected same-origin script runs — so the check above can see it", hit("editor /hit/external-script"));
check("…and reaches the editor page — which is what the sandbox prevents", titleOf(control.stdout) === "pwned");

editor.close();
storage.close();
fs.rmSync(profile, { recursive: true, force: true });

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
