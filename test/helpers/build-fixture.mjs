// Builds the fixture corpus into a temporary tree and reports what it emitted.
//
// The public generator is driven through the BLOG_* directory overrides so the
// harness never touches real content or the real dist/. Everything else about
// the build is untouched, so what these helpers measure is exactly what ships.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES = path.join(ROOT, "test", "fixtures");
export const GOLDEN = path.join(ROOT, "test", "golden");

/** Every file under `dir`, as repo-relative POSIX paths, sorted. */
export function walk(dir) {
  const out = [];
  (function rec(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) rec(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  })(dir);
  return out.sort();
}

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Build the fixture corpus into a fresh temp directory.
 * Returns the dist path; the caller is responsible for cleanup.
 */
export function buildFixtures({ postsDir = path.join(FIXTURES, "content", "posts") } = {}) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "blog-fixture-"));
  execFileSync(process.execPath, [path.join(ROOT, "build.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      BLOG_POSTS_DIR: postsDir,
      BLOG_ASSETS_DIR: path.join(FIXTURES, "assets"),
      BLOG_DIST_DIR: dist,
    },
    stdio: "pipe",
  });
  return dist;
}

/** path -> sha256 for every emitted file. */
export function manifestOf(dist) {
  const manifest = {};
  for (const rel of walk(dist)) {
    manifest[rel] = sha256(fs.readFileSync(path.join(dist, rel)));
  }
  return manifest;
}

/**
 * Pages kept as full text in the golden set. A hash tells you *that* a page
 * moved; these tell you *how*, which is what makes a golden diff reviewable.
 */
export const GOLDEN_PAGES = [
  "index.html",
  "markdown-kitchen-sink/index.html",
  "latex-note/index.html",
  "embeds/index.html",
  "tags/testing/index.html",
  "feed.xml",
  "sitemap.xml",
];

export function readGoldenManifest() {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN, "manifest.json"), "utf8"));
}

export function cleanup(dist) {
  fs.rmSync(dist, { recursive: true, force: true });
}
