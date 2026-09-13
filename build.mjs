// Static site generator: published posts (R2, or BLOG_POSTS_DIR) -> dist/
// (static HTML, build-time KaTeX math). CLAUDE.md §1.1.
//
// `node build.mjs` builds once. `buildSite` and `buildAndReport` are exported
// for scripts/dev.mjs, which rebuilds in-process against the store it serves.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

import { collectPosts, groupByTag, loadPost, ContentError } from "./lib/content.mjs";
import { ENGINE } from "./lib/sanitize.mjs";
import { hasR2Config } from "./lib/server/config.mjs";
import { postPage, listPage, tagPage, notFoundPage, tagSlug, feedWeight } from "./lib/templates.mjs";
import { listingPages, FEED_PAGE_BYTES } from "./lib/listing.mjs";
import { rss, sitemap, robots } from "./lib/feed.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Directory overrides let the test harness build a fixture corpus into a temp
// tree without touching real content. Unset in normal use -> identical output.
const POSTS_DIR = process.env.BLOG_POSTS_DIR || path.join(ROOT, "content", "posts");
const ASSETS_DIR = process.env.BLOG_ASSETS_DIR || path.join(ROOT, "assets");
const DIST = process.env.BLOG_DIST_DIR || path.join(ROOT, "dist");
// Same purpose: lets a test paginate a small corpus. Unset in normal use.
const FEED_BUDGET = Number(process.env.BLOG_FEED_PAGE_BYTES) || FEED_PAGE_BYTES;
const KATEX_DIST = path.join(ROOT, "node_modules", "katex", "dist");
// What a preview deployment shows when it has no R2 credentials, which is every
// preview (CLAUDE.md Step 2): the test corpus, so a preview is a site to look at
// rather than an empty one. Never in production.
const PREVIEW_FIXTURES = path.join(ROOT, "test", "fixtures");

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// Read post sources from disk and hand them to the shared content pipeline.
// This is the only part of the generator that knows about files at all; the R2
// reader will sit beside it and produce the same post objects (CLAUDE.md §1.1).
function loadPosts(postsDir = POSTS_DIR) {
  if (!fs.existsSync(postsDir)) return [];
  const files = fs
    .readdirSync(postsDir)
    .filter((f) => f.endsWith(".md") || f.endsWith(".tex"))
    .sort(); // stable input order; ties are broken deterministically downstream
  const posts = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(postsDir, file), "utf8");
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
async function readPosts(store) {
  if (process.env.BLOG_POSTS_DIR) {
    console.log("  content: filesystem (BLOG_POSTS_DIR)");
    return { posts: loadPosts() };
  }
  if (store || hasR2Config()) {
    const { loadPublishedPosts } = await import("./lib/server/published.mjs");
    const posts = await loadPublishedPosts(store ? { store } : {});
    console.log(`  content: R2 (${posts.length} published)`);
    return { posts };
  }
  if (process.env.VERCEL_ENV === "preview") {
    console.log("  content: test fixtures (a preview deployment with no R2 credentials)");
    return { posts: loadPosts(path.join(PREVIEW_FIXTURES, "content", "posts")), fixtures: true };
  }
  console.log("  content: filesystem (no R2 credentials configured)");
  return { posts: loadPosts() };
}

/**
 * Fetch and verify every image the published posts show (CLAUDE.md §3.3).
 *
 * Only posts from R2 carry media, so a filesystem build never needs a store.
 * The cache lives under node_modules/ because Vercel keeps that directory
 * between builds, which is what stops clean-build cost growing with every post.
 */
async function syncMedia(posts, { store, distDir }) {
  if (!posts.some((post) => post.media?.length || post.interactives?.length)) return;
  const [{ createStore }, { syncPublishedMedia }] = await Promise.all([
    import("./lib/server/r2.mjs"),
    import("./lib/server/media-sync.mjs"),
  ]);
  const stats = await syncPublishedMedia({
    store: store ?? createStore(),
    posts,
    distDir,
    cacheDir: path.join(ROOT, "node_modules", ".cache", "weblog-media"),
  });
  console.log(
    `  media: ${stats.files} file(s)${stats.bundleFiles ? ` (${stats.bundleFiles} interactive)` : ""}, ` +
    `${stats.downloaded} downloaded, ${stats.cached} from cache, ` +
    `${(stats.bytes / 1024).toFixed(1)} KB in ${stats.ms} ms`
  );
}

/** Build the site into `distDir`, from `store` when given, else as configured. */
export async function buildSite({ store = null, distDir = DIST } = {}) {
  const write = (rel, content) => {
    const file = path.join(distDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const copyInto = (srcDir, destRel) => {
    if (!fs.existsSync(srcDir)) return;
    fs.cpSync(srcDir, path.join(distDir, destRel), { recursive: true });
  };

  const started = Date.now();
  console.log("Building blog...");
  rmrf(distDir);
  fs.mkdirSync(distDir, { recursive: true });

  const { posts, fixtures } = await readPosts(store);
  // Before any page is written: a missing or corrupt image stops the build
  // here, rather than after half a site has been emitted.
  await syncMedia(posts, { store, distDir });

  // Per-post pages -> /<slug>/index.html (pretty URLs)
  for (const post of posts) {
    write(path.join(post.slug, "index.html"), postPage(post));
  }

  // Listings: the home page and one per tag, each split into feed pages by
  // rendered weight (lib/listing.mjs) -> <base>index.html, <base>page/<n>/index.html.
  // Posts are already newest-first, so every listing inherits that order.
  const listing = { pages: 0, heaviest: 0 };
  const writeListing = (base, scope, render) => {
    for (const page of listingPages(scope, { base, budget: FEED_BUDGET, weigh: feedWeight })) {
      const html = render(page);
      write(path.join(page.path, "index.html"), html);
      listing.pages++;
      listing.heaviest = Math.max(listing.heaviest, Buffer.byteLength(html));
    }
  };

  writeListing("/", posts, (page) => listPage(posts, page));
  const tagMap = groupByTag(posts, tagSlug);
  const tagPaths = [];
  for (const [slug, { tag, posts: tagged }] of tagMap) {
    writeListing(`/tags/${slug}/`, tagged, (page) => tagPage(tag, tagged, page));
    tagPaths.push(`/tags/${slug}/`);
  }
  console.log(`  listings: ${listing.pages} page(s), heaviest ${(listing.heaviest / 1024).toFixed(1)} KB`);

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
  // The fixture corpus's own images and embed assets, beside the real engine's.
  if (fixtures) {
    copyInto(path.join(PREVIEW_FIXTURES, "assets", "images"), "images");
    copyInto(path.join(PREVIEW_FIXTURES, "assets", "posts"), "assets/posts");
  }
  for (const script of ["blog.js", "editor.js", "login.js", "preview-run.js"]) {
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
  console.log(`Done: ${posts.length} post(s) -> ${path.relative(ROOT, distDir)}/ in ${Date.now() - started} ms`);
}

/**
 * Leave a note in R2 saying why this build failed (CLAUDE.md Step 7).
 *
 * The editor cannot otherwise tell a failed build from a slow one: it watches
 * the public build manifest, and a build that fails never publishes one. Vercel's
 * dashboard knows, but the reason lives in build logs that Hobby keeps for an
 * hour. So the build says so itself, in the one place the editor already reads.
 *
 * One key, rewritten on failure and deleted on success, so it never accumulates
 * and its presence always means "the most recent build failed". Reporting must
 * never mask the real failure, so every error here is swallowed.
 */
async function reportBuild(failure, given = null) {
  if (!given && !hasR2Config()) return;
  try {
    const [{ createStore }, { keys }] = await Promise.all([
      import("./lib/server/r2.mjs"),
      import("./lib/server/keys.mjs"),
    ]);
    const store = given ?? createStore();
    if (!failure) return void await store.delete(keys.lastBuildFailure);
    await store.put(keys.lastBuildFailure, JSON.stringify({
      schemaVersion: 1,
      kind: failure.kind,
      reason: failure.reason,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      at: new Date().toISOString(),
    }), { contentType: "application/json" });
  } catch {
    // A build that cannot report is still a build. Never turn a successful one
    // into a failure, or an informative failure into a confusing one.
  }
}

/**
 * Build, and record the outcome where the editor reads it. Resolves to
 * `{ ok: true }` or `{ ok: false, kind, reason, error }`, and throws nothing:
 * a caller decides what a failed build means for it.
 */
export async function buildAndReport(options = {}) {
  try {
    await buildSite(options);
    await reportBuild(null, options.store);
    return { ok: true };
  } catch (err) {
    // The two failures this system produces itself, and the only two whose
    // cause is worth a reader's time. Anything else is a bug and keeps its stack.
    const kind = err instanceof ContentError ? "content"
      : err?.name === "MediaSyncError" ? "media"
        : "build";
    const reason = kind === "build" ? String(err?.message ?? err).slice(0, 500) : err.message;
    await reportBuild({ kind, reason }, options.store);
    return { ok: false, kind, reason, error: err };
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const result = await buildAndReport();
  if (!result.ok) {
    if (result.kind === "build") throw result.error;
    console.error(`\n${result.kind === "content" ? "Content" : "Media"} error: ${result.reason}\n`);
    process.exit(1);
  }
}
