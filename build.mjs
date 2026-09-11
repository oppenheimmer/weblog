// Static site generator: content/posts/*.md -> dist/ (static HTML, build-time KaTeX math).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

import { collectPosts, groupByTag, loadPost, ContentError } from "./lib/content.mjs";
import { ENGINE } from "./lib/sanitize.mjs";
import { hasR2Config } from "./lib/server/config.mjs";
import { postPage, listPage, tagPage, notFoundPage, tagSlug } from "./lib/templates.mjs";
import { rss, sitemap, robots } from "./lib/feed.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Directory overrides let the test harness build a fixture corpus into a temp
// tree without touching real content. Unset in normal use -> identical output.
const POSTS_DIR = process.env.BLOG_POSTS_DIR || path.join(ROOT, "content", "posts");
const ASSETS_DIR = process.env.BLOG_ASSETS_DIR || path.join(ROOT, "assets");
const DIST = process.env.BLOG_DIST_DIR || path.join(ROOT, "dist");
const KATEX_DIST = path.join(ROOT, "node_modules", "katex", "dist");

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}
function write(rel, content) {
  const file = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function copyInto(srcDir, destRel) {
  if (!fs.existsSync(srcDir)) return;
  fs.cpSync(srcDir, path.join(DIST, destRel), { recursive: true });
}

// Read post sources from disk and hand them to the shared content pipeline.
// This is the only part of the generator that knows about files at all; the R2
// reader will sit beside it and produce the same post objects (CLAUDE.md §1.1).
function loadPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".tex"))
    .sort(); // stable input order; ties are broken deterministically downstream
  const posts = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), "utf8");
    // The only ENGINE-trust call site in the project: these files are in the
    // repository, so they are the owner's own and may embed raw HTML and the
    // per-post script hooks. Everything arriving from R2 is untrusted by default.
    const post = loadPost(raw, { sourceName: file, trust: ENGINE });
    if (!post) {
      console.log(`  - skipped (draft): ${file}`);
      continue;
    }
    posts.push(post);
  }

  return collectPosts(posts);
}

/**
 * Where content comes from (CLAUDE.md §1.1).
 *
 * R2 is the source of truth. The filesystem path stays for two reasons: the
 * test harness drives it through BLOG_POSTS_DIR, and a clone of the engine with
 * no credentials should still build something rather than crash.
 */
async function readPosts() {
  if (process.env.BLOG_POSTS_DIR) {
    console.log("  content: filesystem (BLOG_POSTS_DIR)");
    return loadPosts();
  }
  if (hasR2Config()) {
    const { loadPublishedPosts } = await import("./lib/server/published.mjs");
    const posts = await loadPublishedPosts();
    console.log(`  content: R2 (${posts.length} published)`);
    return posts;
  }
  console.log("  content: filesystem (no R2 credentials configured)");
  return loadPosts();
}

/**
 * Fetch and verify every image the published posts show (CLAUDE.md §3.3).
 *
 * Only posts from R2 carry media, so a filesystem build never needs a store.
 * The cache lives under node_modules/ because Vercel keeps that directory
 * between builds, which is what stops clean-build cost growing with every post.
 */
async function syncMedia(posts) {
  if (!posts.some((post) => post.media?.length)) return;
  const [{ createStore }, { syncPublishedMedia }] = await Promise.all([
    import("./lib/server/r2.mjs"),
    import("./lib/server/media-sync.mjs"),
  ]);
  const stats = await syncPublishedMedia({
    store: createStore(),
    posts,
    distDir: DIST,
    cacheDir: path.join(ROOT, "node_modules", ".cache", "weblog-media"),
  });
  console.log(
    `  media: ${stats.files} file(s), ${stats.downloaded} downloaded, ${stats.cached} from cache, ` +
    `${(stats.bytes / 1024).toFixed(1)} KB in ${stats.ms} ms`
  );
}

async function build() {
  const started = Date.now();
  console.log("Building blog...");
  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  const posts = await readPosts();
  // Before any page is written: a missing or corrupt image stops the build
  // here, rather than after half a site has been emitted.
  await syncMedia(posts);

  // Per-post pages -> /<slug>/index.html (pretty URLs)
  for (const post of posts) {
    write(path.join(post.slug, "index.html"), postPage(post));
  }

  // Per-tag pages -> /tags/<slug>/index.html. Posts are already newest-first,
  // so each tag's list inherits that order.
  const tagMap = groupByTag(posts, tagSlug);
  const tagPaths = [];
  for (const [slug, { tag, posts: tagged }] of tagMap) {
    write(path.join("tags", slug, "index.html"), tagPage(tag, tagged));
    tagPaths.push(`/tags/${slug}/`);
  }

  // Listing, 404
  write("index.html", listPage(posts));
  write("404.html", notFoundPage());

  // Feeds + crawl files
  // Names the revisions this build contains, so a deployment can be checked
  // against what was actually published. No private fields, no credentials.
  // Deliberately carries no timestamp: identical content must produce an
  // identical build, and "when it was assembled" is not what Step 7 verifies.
  write("build-manifest.json", JSON.stringify({
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    posts: posts.map((p) => ({
      slug: p.slug, postId: p.postId ?? null, revisionId: p.revisionId ?? null,
    })),
  }, null, 2));

  write("feed.xml", rss(posts));
  write("sitemap.xml", sitemap(posts, tagPaths));
  write("robots.txt", robots());

  // Static assets
  copyInto(path.join(ASSETS_DIR, "styles"), "styles");
  // Global media (images, etc.) referenced as /images/… from any post.
  copyInto(path.join(ASSETS_DIR, "images"), "images");
  // Per-post embed assets and vendored libraries (e.g. distill template).
  copyInto(path.join(ASSETS_DIR, "posts"), "assets/posts");
  copyInto(path.join(ASSETS_DIR, "vendor"), "assets/vendor");
  for (const script of ["blog.js", "editor.js", "login.js"]) {
    const file = path.join(ASSETS_DIR, script);
    if (fs.existsSync(file)) write(path.join("assets", script), fs.readFileSync(file));
  }
  if (fs.existsSync(path.join(ASSETS_DIR, "favicon.svg")))
    write("favicon.svg", fs.readFileSync(path.join(ASSETS_DIR, "favicon.svg")));

  // KaTeX CSS + fonts (self-hosted; no CDN runtime dependency)
  const katexCss = path.join(KATEX_DIST, "katex.min.css");
  if (!fs.existsSync(katexCss)) {
    throw new Error("katex.min.css not found — run `npm install` first.");
  }
  // katex.min.css references url(fonts/...) relative to itself, so fonts live at styles/fonts/.
  write("styles/katex.min.css", fs.readFileSync(katexCss));
  copyInto(path.join(KATEX_DIST, "fonts"), "styles/fonts");

  // Duration on every build, so the growth §3.3 warns about is visible before it bites.
  console.log(`Done: ${posts.length} post(s) -> ${path.relative(ROOT, DIST)}/ in ${Date.now() - started} ms`);
}

try {
  await build();
} catch (err) {
  if (err instanceof ContentError) {
    console.error(`\nContent error: ${err.message}\n`);
    process.exit(1);
  }
  if (err?.name === "MediaSyncError") {
    console.error(`\nMedia error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
