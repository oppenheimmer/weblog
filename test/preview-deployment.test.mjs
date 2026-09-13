// Tier 1/7 — what a preview deployment shows (CLAUDE.md Step 2).
//
// Every variable is scoped to Production, so a preview build has no R2
// credentials. It builds the test corpus instead of an empty site. The promise
// that matters more is the other half: production never does, credentials or
// not, and neither does a build that says nothing about where it runs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT, walk } from "./helpers/build-fixture.mjs";

function build(t, vercelEnv) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-preview-"));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/^(R2_|AWS_|BLOG_|VERCEL_)/.test(name)));
  const output = execFileSync(process.execPath, [path.join(ROOT, "build.mjs")], {
    cwd: ROOT, encoding: "utf8", stdio: "pipe",
    env: { ...env, SITE_URL: "", BLOG_DIST_DIR: dist, ...(vercelEnv ? { VERCEL_ENV: vercelEnv } : {}) },
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, "build-manifest.json"), "utf8"));
  return { dist, output, slugs: manifest.posts.map((post) => post.slug), files: walk(dist) };
}

test("a preview deployment with no credentials builds the fixture corpus, images included", (t) => {
  const { output, slugs, files, dist } = build(t, "preview");
  assert.match(output, /content: test fixtures/);
  for (const slug of ["markdown-kitchen-sink", "latex-note", "embeds"]) {
    assert.ok(slugs.includes(slug), `${slug} is missing from the preview: ${slugs.join(", ")}`);
    assert.ok(files.includes(`${slug}/index.html`));
  }
  assert.ok(files.includes("images/diagram.png"), "the fixture corpus's image was not copied");
  // The real engine's scripts and styles, not the fixtures' stand-ins.
  assert.deepEqual(fs.readFileSync(path.join(dist, "assets", "blog.js")),
    fs.readFileSync(path.join(ROOT, "assets", "blog.js")));
});

test("production and an unmarked build without credentials stay empty", (t) => {
  for (const vercelEnv of ["production", "development", null]) {
    const { slugs, output } = build(t, vercelEnv);
    assert.deepEqual(slugs, [], `${vercelEnv ?? "an unmarked build"} published fixture posts`);
    assert.doesNotMatch(output, /test fixtures/);
  }
});
