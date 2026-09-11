// The content pipeline: raw source text -> a validated, rendered post object.
//
// Deliberately knows nothing about where content comes from. `build.mjs` feeds
// it files today; the R2 reader and the editor's preview and publish paths feed
// it strings later (CLAUDE.md §1.1, Step 6). Keeping filesystem access out of
// here is what makes one pipeline serve all three.
import matter from "gray-matter";

import { rendererFor, hasMath, readingTime, readingTimeFromText, toPlainText } from "./markdown.mjs";
import { renderLatex, stripHtml } from "./latex.mjs";
import { slugify } from "./templates.mjs";
import { DEFAULT_TRUST, isTrusted } from "./sanitize.mjs";

export const FORMATS = ["markdown", "latex"];

// Slugs that would collide with a generated route. `<slug>/index.html` is
// written straight into dist/, so a post claiming one of these would either
// overwrite a real page or be shadowed by it.
export const RESERVED_SLUGS = new Set([
  "tags", "images", "assets", "styles", "downloads", "page",
  "api", "editor", "login", "logout", "admin",
  "404", "feed", "feed.xml", "sitemap", "sitemap.xml", "robots", "robots.txt",
  "favicon.svg", "index",
]);

const MAX_DESCRIPTION = 160;

/** A content problem worth showing the author verbatim, rather than a stack trace. */
export class ContentError extends Error {
  constructor(message, { source, field } = {}) {
    super(message);
    this.name = "ContentError";
    this.source = source;
    this.field = field;
  }
}

/** Infer the render format from a filename. Sources without one must say so. */
export function formatFromFilename(filename = "") {
  return filename.endsWith(".tex") ? "latex" : "markdown";
}

/**
 * Slug for a post: an explicit frontmatter `slug` wins, otherwise the filename
 * with its date prefix dropped. Kept here so the editor derives slugs exactly
 * the way the build always has.
 */
export function derivePostSlug({ filename = "", frontmatterSlug } = {}) {
  if (frontmatterSlug) return slugify(String(frontmatterSlug));
  const base = filename.replace(/\.[^.]+$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  return slugify(base);
}

/** Split a raw document into frontmatter data and body. */
export function parseSource(raw) {
  // gray-matter strips the same `---` YAML block from .md and .tex alike.
  const { data, content } = matter(String(raw));
  return { data: data || {}, body: content };
}

function renderBody(body, format, trust) {
  return format === "latex" ? renderLatex(body, { trust }) : rendererFor(trust).render(body);
}

/**
 * Normalize one parsed document into the post shape the templates consume.
 * Throws ContentError on anything an author needs to fix. Returns null for a
 * draft, which is an exclusion rather than an error.
 *
 * `trust` says where the source came from, and defaults to the untrusted value
 * on purpose: a caller that forgets to pass it gets the safe behaviour, not the
 * permissive one. Only build.mjs, reading files out of the repository, may pass
 * ENGINE. See lib/sanitize.mjs.
 */
export function normalizePost({ data, body, format, sourceName = "(unnamed)", trust = DEFAULT_TRUST }) {
  if (!FORMATS.includes(format)) {
    throw new ContentError(`Unknown format "${format}".`, { source: sourceName, field: "format" });
  }
  if (data.draft === true) return null;

  for (const field of ["title", "date"]) {
    if (!data[field]) {
      throw new ContentError(
        `Post "${sourceName}" is missing required frontmatter: title and date.`,
        { source: sourceName, field }
      );
    }
  }

  const date = new Date(data.date);
  if (Number.isNaN(date.getTime())) {
    throw new ContentError(
      `Post "${sourceName}" has an unparseable date: ${JSON.stringify(data.date)}.`,
      { source: sourceName, field: "date" }
    );
  }

  const slug = derivePostSlug({ filename: sourceName, frontmatterSlug: data.slug });
  if (!slug) {
    throw new ContentError(
      `Post "${sourceName}" produces an empty slug. Give it a \`slug:\` in frontmatter.`,
      { source: sourceName, field: "slug" }
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new ContentError(
      `Post "${sourceName}" uses the reserved slug "${slug}", which collides with a generated route.`,
      { source: sourceName, field: "slug" }
    );
  }

  const trusted = isTrusted(trust);
  const isTex = format === "latex";
  const html = renderBody(body, format, trust);
  const math = data.math === true || (data.math !== false && hasMath(html));
  const description =
    data.description || (isTex ? stripHtml(html) : toPlainText(body)).slice(0, MAX_DESCRIPTION);

  return {
    sourceFile: sourceName,
    slug,
    title: data.title,
    date: date.toISOString(),
    description,
    tags: Array.isArray(data.tags) ? data.tags : [],
    math,
    readingTime: isTex ? readingTimeFromText(stripHtml(html)) : readingTime(body),
    // Per-post embed hooks (see lib/templates.mjs postAssets). These inject raw
    // markup and script tags into the page head, so only repository-authored
    // content may set them. publish.mjs also drops them when writing a revision;
    // this is the second of the two locks, and the one that holds if a future
    // path forgets the first.
    styles: trusted && Array.isArray(data.styles) ? data.styles : [],
    scripts: trusted && Array.isArray(data.scripts) ? data.scripts : [],
    head: trusted && typeof data.head === "string" ? data.head : "",
    distill: trusted && data.distill === true,
    html,
  };
}

/** Parse, normalize and render one raw document in a single call. */
export function loadPost(raw, { sourceName = "(unnamed)", format, trust = DEFAULT_TRUST } = {}) {
  const { data, body } = parseSource(raw);
  return normalizePost({
    data,
    body,
    format: format || formatFromFilename(sourceName),
    sourceName,
    trust,
  });
}

/**
 * Reject two posts that would be written to the same path. Without this they
 * overwrite each other in dist/ silently, and the survivor depends on iteration
 * order.
 */
export function assertUniqueSlugs(posts) {
  const seen = new Map();
  for (const post of posts) {
    const previous = seen.get(post.slug);
    if (previous) {
      throw new ContentError(
        `Duplicate slug "${post.slug}": both "${previous}" and "${post.sourceFile}" ` +
        `resolve to /${post.slug}/. Set a distinct \`slug:\` in the frontmatter of one of them.`,
        { source: post.sourceFile, field: "slug" }
      );
    }
    seen.set(post.slug, post.sourceFile);
  }
  return posts;
}

/**
 * Newest first. Equal dates fall back to the slug so ordering never depends on
 * the order a filesystem or object store happens to return.
 */
export function sortPosts(posts) {
  return [...posts].sort((a, b) => {
    const byDate = new Date(b.date) - new Date(a.date);
    return byDate !== 0 ? byDate : a.slug.localeCompare(b.slug);
  });
}

/** Validate a whole collection and put it in render order. */
export function collectPosts(posts) {
  return sortPosts(assertUniqueSlugs(posts));
}

/** Group posts by tag slug, preserving the order they were given in. */
export function groupByTag(posts, tagSlug = slugify) {
  const tags = new Map();
  for (const post of posts) {
    for (const tag of post.tags) {
      const slug = tagSlug(tag);
      if (!tags.has(slug)) tags.set(slug, { tag, posts: [] });
      tags.get(slug).posts.push(post);
    }
  }
  return tags;
}
