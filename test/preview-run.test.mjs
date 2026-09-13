// Tier 3/4 — Run interactive preview (CLAUDE.md §3.6).
//
// A draft's bundles have no public copy, so a Run preview serves them through
// the preview function on a grant. Three promises, each asserted here:
//
//   * a grant reads one verified revision of one interactive, until it
//     expires, and a forged, altered or expired one reads nothing;
//   * what is served is only what the manifest declares, with the published
//     lab path's policy — sandboxed if opened directly, readable by the opaque
//     origin that imports it, never cached — and the grant never reaches a log;
//   * a Run preview is the ordinary preview with each used interactive pointed
//     at its grant and nothing else changed, and an ordinary one grants nothing.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads } from "../lib/server/uploads.mjs";
import { createInteractives } from "../lib/server/interactives.mjs";
import { createPreviewer, PreviewError } from "../lib/server/preview.mjs";
import { createSessionStore } from "../lib/server/sessions.mjs";
import { setContext } from "../lib/server/http.mjs";
import {
  mintRunGrant, readRunGrant, runTarget, createRunFiles, runDirectory,
  RUN_GRANT_TTL_SECONDS, MAX_RUN_FILE_BYTES,
} from "../lib/server/run-grants.mjs";
import previewRoute from "../api/preview/index.js";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PNG = fs.readFileSync(path.join(ROOT, "test", "fixtures", "media", "sample-7x11.png"));
const SECRET = "preview-run-test";
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const LAB = {
  "index.html": "<!doctype html><title>orbit</title><script type=module src=./demo.mjs></script>",
  "demo.mjs": "import './lib/nested.mjs';\n",
  "lib/nested.mjs": "export const nested = true;\n",
  "data.json": '{"points":[1,2,3]}',
  "fallback.html": '<p>Three planets, drawn still.</p><img src="still.png" alt="the orbit" />',
  "still.png": PNG,
};
const FIGURE = {
  "main.mjs": "export function mount(root) { root.textContent = 'mounted'; }\n",
  "fallback.html": "<p>A static figure.</p>",
};

async function harness() {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const signPut = async (key) => `https://signed.test/${key}`;
  const signGet = async (key) => `https://weblog-test.fake.r2.cloudflarestorage.com/${key}?X-Amz-Signature=abc`;
  const uploads = createUploads(store, { signPut });
  const interactives = createInteractives(store, { signPut });
  const drafts = createDraftStore(store);
  const { draft } = await drafts.create({ title: "Orbits", date: "2026-07-01", slug: "orbits", body: "seed" });
  const previewer = createPreviewer(store, { uploads, interactives, signGet, runSecret: SECRET });
  return { store, uploads, interactives, drafts, draft, previewer, signGet };
}

async function attach(h, files, { kind = "demo", name = "orbit", entry = "index.html" } = {}) {
  const buffers = Object.entries(files).map(([file, body]) => [file, Buffer.from(body)]);
  const agreed = await h.interactives.begin({
    postId: h.draft.postId,
    manifest: {
      kind, name, entry, fallback: "fallback.html",
      files: buffers.map(([file, bytes]) => ({ name: file, bytes: bytes.length, sha256: sha256(bytes) })),
    },
  });
  for (const upload of agreed.uploads) {
    const [, bytes] = buffers.find(([file]) => file === upload.name);
    await h.store.put(`uploads/${h.draft.postId}/${agreed.uploadId}/files/${upload.name}`, bytes);
  }
  return h.interactives.complete({ postId: h.draft.postId, uploadId: agreed.uploadId });
}

const target = (h, record) => ({ postId: h.draft.postId, interactiveId: record.id, revisionId: record.revisionId });

// ---------------------------------------------------------------- grants

test("a grant reads back as the one revision it was minted for, until it expires", () => {
  const ids = { postId: "p_00000000000000aa", interactiveId: "i_00000000000000bb", revisionId: "iv_00000000000000cc" };
  const now = Date.UTC(2026, 8, 13, 12);
  const grant = mintRunGrant(ids, { secret: SECRET, now });
  assert.match(grant, /^[A-Za-z0-9._-]+$/, "a grant must be one plain path segment");
  assert.deepEqual(readRunGrant(grant, { secret: SECRET, now }), ids);
  assert.deepEqual(readRunGrant(grant, { secret: SECRET, now: now + (RUN_GRANT_TTL_SECONDS - 1) * 1000 }), ids);
  assert.equal(readRunGrant(grant, { secret: SECRET, now: now + RUN_GRANT_TTL_SECONDS * 1000 }), null, "an expired grant still reads");
  assert.ok(RUN_GRANT_TTL_SECONDS <= 3600, "a run grant is a bearer capability and must be short-lived");
});

test("a grant for another revision, signed with another secret, or altered in any part reads nothing", () => {
  const ids = { postId: "p_00000000000000aa", interactiveId: "i_00000000000000bb", revisionId: "iv_00000000000000cc" };
  const now = Date.UTC(2026, 8, 13, 12);
  const grant = mintRunGrant(ids, { secret: SECRET, now });
  const [post, interactive, revision, expires, mac] = grant.split(".");
  const altered = [
    [post, interactive, "iv_00000000000000dd", expires, mac],
    [post, "i_00000000000000ee", revision, expires, mac],
    ["p_00000000000000ff", interactive, revision, expires, mac],
    [post, interactive, revision, (parseInt(expires, 36) + 3600).toString(36), mac],
    [post, interactive, revision, expires, `${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`],
  ].map((parts) => parts.join("."));
  for (const forged of altered) {
    assert.equal(readRunGrant(forged, { secret: SECRET, now }), null, `accepted ${forged}`);
  }
  assert.equal(readRunGrant(grant, { secret: "another-secret", now }), null);
  assert.equal(readRunGrant(grant, { secret: undefined, now }), null);
  for (const junk of ["", "x", `${grant}/`, `../${grant}`, null]) {
    assert.equal(readRunGrant(junk, { secret: SECRET, now }), null);
  }
  assert.throws(() => mintRunGrant(ids, { secret: "" }), /RATE_LIMIT_HASH_SECRET/);
});

test("a run address is read from the rewrite's query, or from the path when that is what arrives", () => {
  assert.deepEqual(runTarget({ url: "/api/preview?grant=g1&file=lib%2Fa.mjs", query: { grant: "g1", file: "lib/a.mjs" } }),
    { grant: "g1", file: "lib/a.mjs" });
  assert.deepEqual(runTarget({ url: "/api/preview/?grant=g1" }), { grant: "g1", file: "" });
  assert.deepEqual(runTarget({ url: "/api/preview/run/g2/lib/a.mjs" }), { grant: "g2", file: "lib/a.mjs" });
  assert.deepEqual(runTarget({ url: "/api/preview/run/g2/" }), { grant: "g2", file: "" });
  assert.equal(runTarget({ url: "/api/preview/" }), null);
});

// ---------------------------------------------------------------- files

test("a granted lab serves its entry at the directory and its declared files by name", async () => {
  const h = await harness();
  const lab = await attach(h, LAB);
  const files = createRunFiles(h.store);

  const entry = await files.read(target(h, lab), "");
  assert.equal(entry.status, 200);
  assert.equal(entry.body.toString(), LAB["index.html"]);
  assert.match(entry.type, /^text\/html/);

  const nested = await files.read(target(h, lab), "lib/nested.mjs");
  assert.deepEqual([nested.status, nested.type, nested.body.toString()],
    [200, "text/javascript; charset=utf-8", LAB["lib/nested.mjs"]]);
  assert.deepEqual((await files.read(target(h, lab), "still.png")).body, PNG);
});

test("nothing outside the manifest is served, and no HTML by name", async () => {
  const h = await harness();
  const lab = await attach(h, LAB);
  const figure = await attach(h, FIGURE, { kind: "figure", name: "chart", entry: "main.mjs" });
  const files = createRunFiles(h.store);

  // An object beside the bundle's files that its manifest does not declare —
  // what an interrupted promotion or a stray write would leave.
  await h.store.put(`interactives/${h.draft.postId}/${lab.id}/${lab.revisionId}/files/extra.mjs`, Buffer.from("stray"));
  for (const file of ["index.html", "fallback.html", "missing.mjs", "extra.mjs", "../index.html", "lib/../demo.mjs", "/demo.mjs", "manifest.json"]) {
    assert.equal((await files.read(target(h, lab), file)).status, 404, `served ${file}`);
  }
  // A figure is imported by name, never navigated to.
  assert.equal((await files.read(target(h, figure), "")).status, 404);
  assert.equal((await files.read(target(h, figure), "main.mjs")).status, 200);
  // A revision that was never verified, and another post's id, read nothing.
  assert.equal((await files.read({ ...target(h, lab), revisionId: "iv_0000000000000000" }, "demo.mjs")).status, 404);
  assert.equal((await files.read({ ...target(h, lab), postId: "p_0000000000000000" }, "demo.mjs")).status, 404);
});

test("a file too large for a function response is refused by size, before it is read", async () => {
  const h = await harness();
  const big = "x".repeat(MAX_RUN_FILE_BYTES + 1);
  const lab = await attach(h, { ...LAB, "big.json": big });
  const read = await createRunFiles(h.store).read(target(h, lab), "big.json");
  assert.equal(read.status, 413);
});

// ---------------------------------------------------------------- the route

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    end(payload) { this.body = payload; return this; },
  };
}

async function get(url) {
  const res = fakeRes();
  await previewRoute({ method: "GET", url, headers: {} }, res);
  return res;
}

test("the route serves a granted file with no session, carrying the lab path's own policy", async () => {
  const h = await harness();
  const lab = await attach(h, LAB);
  const lines = [];
  setContext({ store: h.store, sessions: createSessionStore(h.store), runSecret: SECRET, log: (line) => lines.push(line) });
  const grant = mintRunGrant(target(h, lab), { secret: SECRET });

  const res = await get(`${runDirectory(grant)}demo.mjs`);
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.body), LAB["demo.mjs"]);
  assert.equal(res.headers["content-security-policy"], "sandbox allow-scripts");
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["content-type"], "text/javascript; charset=utf-8");

  const entry = await get(runDirectory(grant));
  assert.equal(entry.headers["content-security-policy"], "sandbox allow-scripts", "a lab opened directly is not sandboxed");

  const line = JSON.parse(lines.at(-1));
  assert.ok(!lines.join("\n").includes(grant.split(".").at(-1)), "a run grant reached the log");
  assert.equal(line.path, "/api/preview/run/-/");
  assert.equal(line.bundleRevisionId, lab.revisionId);
});

test("without a valid grant the route reads nothing, and rendering still needs a session", async () => {
  const h = await harness();
  const lab = await attach(h, LAB);
  setContext({ store: h.store, sessions: createSessionStore(h.store), runSecret: SECRET, log: () => {} });
  const expired = mintRunGrant(target(h, lab), { secret: SECRET, now: Date.now() - (RUN_GRANT_TTL_SECONDS + 5) * 1000 });
  const forged = mintRunGrant(target(h, lab), { secret: "not-the-secret" });

  for (const url of [`${runDirectory(expired)}demo.mjs`, `${runDirectory(forged)}demo.mjs`, "/api/preview/run/nonsense/demo.mjs"]) {
    const res = await get(url);
    assert.equal(res.statusCode, 404, url);
    assert.equal(res.headers["access-control-allow-origin"], undefined, "a refusal was made readable to any origin");
  }

  process.env.SITE_URL = "https://blog.example";
  const res = fakeRes();
  await previewRoute({ method: "POST", url: "/api/preview/", headers: { origin: "https://blog.example" }, body: {} }, res);
  assert.equal(res.statusCode, 401, "the grant route opened rendering to anonymous callers");
});

// ---------------------------------------------------------------- rendering

async function postUsing(h) {
  const lab = await attach(h, LAB);
  const figure = await attach(h, FIGURE, { kind: "figure", name: "chart", entry: "main.mjs" });
  const current = await h.drafts.get(h.draft.postId);
  const { draft } = await h.drafts.save(h.draft.postId,
    { body: `Before.\n\n::demo[${lab.id}]\n\n::figure[${figure.id}]\n`, slug: "orbits" }, current.etag);
  const fields = {
    title: draft.title, date: draft.date, slug: draft.slug, format: draft.format,
    body: draft.body, postId: draft.postId,
  };
  return { lab, figure, fields };
}

test("a Run preview points each used interactive at its grant, and adds only the figure loader", async () => {
  const h = await harness();
  const { lab, figure, fields } = await postUsing(h);
  const plain = await h.previewer.render(fields);
  const running = await h.previewer.render({ ...fields, run: true });

  assert.equal(running.running, 2);
  const srcs = [...running.html.matchAll(/data-interactive-src="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(srcs.length, 2);
  const [labSrc] = srcs.filter((src) => src.endsWith("/"));
  const [figureSrc] = srcs.filter((src) => src.endsWith("/main.mjs"));
  const grantOf = (src) => src.slice("/api/preview/run/".length).split("/")[0];
  assert.deepEqual(readRunGrant(grantOf(labSrc), { secret: SECRET }), target(h, lab));
  assert.deepEqual(readRunGrant(grantOf(figureSrc), { secret: SECRET }), target(h, figure));
  assert.match(running.html, /<script src="\/assets\/preview-run\.js"><\/script>/);

  // Everything else is the ordinary preview, byte for byte.
  let restored = running.html
    .replace(labSrc, `/demos/orbits/orbit/${lab.revisionId}/index.html`)
    .replace(figureSrc, `/assets/figures/orbits/chart/${figure.revisionId}/main.mjs`)
    .replace('\n  <script src="/assets/preview-run.js"></script>', "");
  assert.equal(restored, plain.html, "a Run preview differs from the preview by more than its grants");
});

test("an ordinary preview grants nothing and runs nothing", async () => {
  const h = await harness();
  const { fields } = await postUsing(h);
  for (const run of [undefined, false, "true", 1]) {
    const preview = await h.previewer.render({ ...fields, run });
    assert.equal(preview.running, 0);
    assert.ok(!preview.html.includes("/api/preview/run/"), `run: ${JSON.stringify(run)} minted a grant`);
    assert.ok(!preview.html.includes("preview-run.js"), `run: ${JSON.stringify(run)} added the figure loader`);
  }
});

test("a Run preview without a signing secret says so rather than rendering something that cannot run", async () => {
  const h = await harness();
  const { fields } = await postUsing(h);
  const previewer = createPreviewer(h.store, { uploads: h.uploads, interactives: h.interactives, signGet: h.signGet });
  await assert.rejects(() => previewer.render({ ...fields, run: true }),
    (err) => err instanceof PreviewError && err.code === "run_unavailable");
});

test("an image in a fallback previews from its unpublished bundle", async () => {
  const h = await harness();
  const { lab, fields } = await postUsing(h);
  const preview = await h.previewer.render(fields);
  assert.ok(!preview.html.includes(`src="/demos/orbits/orbit/${lab.revisionId}/still.png"`),
    "the preview points at a published path that does not exist yet");
  assert.ok(preview.html.includes(
    `interactives/${h.draft.postId}/${lab.id}/${lab.revisionId}/files/still.png?X-Amz-Signature=abc`));
});
