// Static site generator: content/posts/*.md -> dist/ (static HTML, build-time KaTeX math).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

import { md, hasMath, readingTime, readingTimeFromText, toPlainText } from "./lib/markdown.mjs";
import { renderLatex, stripHtml } from "./lib/latex.mjs";
import { postPage, listPage, tagPage, notFoundPage, tagSlug, slugify } from "./lib/templates.mjs";
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

function slugFromFilename(file, fmSlug) {
  if (fmSlug) return fmSlug;
  const base = path
    .basename(file, path.extname(file))
    .replace(/^\d{4}-\d{2}-\d{2}-/, ""); // drop leading date prefix
  return slugify(base);
}

function loadPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const files = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".tex"));
  const posts = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), "utf8");
    // gray-matter strips the same `---` YAML block from .md and .tex alike.
    const { data, content } = matter(raw);

    if (data.draft === true) {
      console.log(`  - skipped (draft): ${file}`);
      continue;
    }
    if (!data.title || !data.date) {
      throw new Error(`Post "${file}" is missing required frontmatter: title and date.`);
    }

    // Markdown vs LaTeX: both produce HTML for the same .prose container.
    const isTex = path.extname(file) === ".tex";
    const html = isTex ? renderLatex(content) : md.render(content);
    const math = data.math === true || (data.math !== false && hasMath(html));
    const description =
      data.description ||
      (isTex ? stripHtml(html) : toPlainText(content)).slice(0, 160);

    posts.push({
      sourceFile: file,
      slug: slugFromFilename(file, data.slug),
      title: data.title,
      date: new Date(data.date).toISOString(),
      description,
      tags: Array.isArray(data.tags) ? data.tags : [],
      math,
      readingTime: isTex ? readingTimeFromText(stripHtml(html)) : readingTime(content),
      // Per-post embed hooks (see lib/templates.mjs postAssets).
      styles: Array.isArray(data.styles) ? data.styles : [],
      scripts: Array.isArray(data.scripts) ? data.scripts : [],
      head: typeof data.head === "string" ? data.head : "",
      distill: data.distill === true,
      html,
    });
  }

  // Two files whose names reduce to the same slug would overwrite one another in
  // dist/ without a word. Fail loudly instead: the author has to pick a slug.
  const bySlug = new Map();
  for (const post of posts) {
    if (bySlug.has(post.slug)) {
      throw new Error(
        `Duplicate slug "${post.slug}": both "${bySlug.get(post.slug)}" and "${post.sourceFile}" ` +
        `resolve to /${post.slug}/. Set a distinct \`slug:\` in the frontmatter of one of them.`
      );
    }
    bySlug.set(post.slug, post.sourceFile);
  }

  // Newest first. Equal dates fall back to the slug so ordering never depends on
  // the order the filesystem happens to hand back from readdir.
  posts.sort((a, b) => {
    const byDate = new Date(b.date) - new Date(a.date);
    return byDate !== 0 ? byDate : a.slug.localeCompare(b.slug);
  });
  return posts;
}

function build() {
  console.log("Building blog...");
  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  const posts = loadPosts();

  // Per-post pages -> /<slug>/index.html (pretty URLs)
  for (const post of posts) {
    write(path.join(post.slug, "index.html"), postPage(post));
  }

  // Per-tag pages -> /tags/<slug>/index.html. Posts are already newest-first,
  // so each tag's list inherits that order.
  const tagMap = new Map(); // slug -> { tag, posts: [] }
  for (const post of posts) {
    for (const tag of post.tags) {
      const slug = tagSlug(tag);
      if (!tagMap.has(slug)) tagMap.set(slug, { tag, posts: [] });
      tagMap.get(slug).posts.push(post);
    }
  }
  const tagPaths = [];
  for (const [slug, { tag, posts: tagged }] of tagMap) {
    write(path.join("tags", slug, "index.html"), tagPage(tag, tagged));
    tagPaths.push(`/tags/${slug}/`);
  }

  // Listing, 404
  write("index.html", listPage(posts));
  write("404.html", notFoundPage());

  // Feeds + crawl files
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
  if (fs.existsSync(path.join(ASSETS_DIR, "blog.js")))
    write("assets/blog.js", fs.readFileSync(path.join(ASSETS_DIR, "blog.js")));
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

  console.log(`Done: ${posts.length} post(s) -> ${path.relative(ROOT, DIST)}/`);
}

build();
