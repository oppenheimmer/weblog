// Tier 7 — inspect the real R2 build with private canaries beside public data.
// Only synthetic credentials are used; the preload intercepts every S3 send.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, walk } from "./helpers/build-fixture.mjs";

let work, dist, fixture, files;
const read = (file) => fs.readFileSync(path.join(dist, file));
before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-output-hygiene-"));
  dist = path.join(work, "dist");
  const record = path.join(work, "fixture.json");
  // Copy only engine/test files, never the real checkout's private files.
  // Deliberate private-file canaries also make accidental copying measurable.
  const engine = path.join(work, "engine");
  fs.mkdirSync(engine);
  for (const name of ["build.mjs", "lib", "api", "assets", "test", "package.json", "vercel.json"]) {
    fs.cpSync(path.join(ROOT, name), path.join(engine, name), { recursive: true });
  }
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(engine, "node_modules"), "dir");
  const privateFile = "audit-private-source-file-bc95";
  fs.writeFileSync(path.join(engine, ".env"), `AUDIT_CANARY=${privateFile}\n`);
  fs.writeFileSync(path.join(engine, "CLAUDE.md"), privateFile);
  const output = execFileSync(process.execPath, [
    "--import", "./test/helpers/seed-private-build.mjs", "build.mjs",
  ], {
    cwd: engine, encoding: "utf8",
    env: {
      ...process.env, BUILD_AUDIT_DIST: dist, BUILD_AUDIT_RECORD: record,
      BUILD_AUDIT_FILE_CANARY: privateFile,
    },
  });
  assert.match(output, /content: R2 \(2 published\)/, "the R2 build path never ran");
  fixture = JSON.parse(fs.readFileSync(record, "utf8"));
  files = walk(dist);
});
after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

test("output hygiene: the public corpus actually renders, with stable media and bundles", () => {
  for (const file of ["public-audit/index.html", "index.html", "tags/audit/index.html"]) {
    const html = read(file).toString();
    assert.match(html, /Public audit prose\./, file);
    assert.match(html, /\/images\/uploads\/public-audit\/diagram\.png/, file);
    assert.match(html, /class=(?:"|&quot;)katex/, file);
    assert.match(html, /Public lab fallback\./, file);
    assert.match(html, /Public figure fallback\./, file);
  }
  assert.match(read("public-tex-audit/index.html").toString(), /Public TeX heading/);
  assert.match(read("feed.xml").toString(), /Public audit prose\./);
  assert.deepEqual(read("images/uploads/public-audit/diagram.png"),
    fs.readFileSync(path.join(ROOT, "test/fixtures/media/sample-7x11.png")));
  for (const { file, body } of fixture.publicBundles) assert.equal(read(file).toString(), body, file);
  assert.match(read("sitemap.xml").toString(), /\/public-audit\//);
  assert.match(read("sitemap.xml").toString(), /\/public-tex-audit\//);
});

test("output hygiene: no credential, private draft, session, upload or metadata is emitted", () => {
  // Scan all bytes, including scripts, feeds, manifests, images and bundle files.
  for (const file of files) {
    const bytes = read(file);
    for (const [label, marker] of Object.entries(fixture.privateValues)) {
      assert.ok(!bytes.includes(Buffer.from(marker)), `${file} leaked ${label}`);
    }
  }
});

test("output hygiene: server files and private source are absent from the static tree", () => {
  for (const file of files) {
    assert.doesNotMatch(file,
      /^(?:api|lib|drafts|attachments|uploads|sessions|publications)(?:\/|$)|(?:^|\/)(?:\.git|\.vercel|\.codex)(?:\/|$)/,
      file);
    assert.doesNotMatch(file,
      /(?:^|\/)(?:\.env(?:\..*)?|CLAUDE\.md|AGENTS\.md|package(?:-lock)?\.json|vercel\.json|build\.mjs)$/i,
      file);
    assert.doesNotMatch(file, /\.(?:md|markdown|tex)$/i, file);
  }
  // Browser clients are intentionally public; server-rendered editor/login
  // documents are not. A blanket ban on the word "editor" would be wrong.
  assert.ok(files.includes("assets/editor.js"));
  assert.ok(files.includes("assets/login.js"));
  for (const file of ["editor.html", "editor/index.html", "login.html", "login/index.html"]) {
    assert.ok(!files.includes(file), `${file} bypasses its authenticated handler`);
  }
});

test("output hygiene: temporary URLs and unresolved references never reach rendered output", () => {
  for (const file of files) {
    assert.doesNotMatch(read(file).toString(), /X-Amz-(?:Signature|Credential|Security-Token|Expires)=/i, file);
    // The editor script teaches attachment syntax; only generated documents
    // are checked for it. This fixture contains real references, no code samples.
    if (/\.(?:html|xml|json)$/.test(file)) {
      assert.doesNotMatch(read(file).toString(), /attachment:\/\/|::(?:tex|demo|figure)\[/, file);
    }
  }
});

test("output hygiene: the public manifest contains only publication identities", () => {
  const manifest = JSON.parse(read("build-manifest.json"));
  assert.deepEqual(manifest, { commit: "audit-public-commit", posts: fixture.posts });
});
