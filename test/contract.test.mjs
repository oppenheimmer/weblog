// Tier 1 — public contract invariants.
//
// Written against the built tree, never against internals, so they survive any
// refactor that keeps the public output honest. These are the promises §2 of
// PLAN.md makes to existing readers, links, and feed subscribers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildFixtures, cleanup, walk } from "./helpers/build-fixture.mjs";

const dist = buildFixtures();
const read = (rel) => fs.readFileSync(path.join(dist, rel), "utf8");
const files = walk(dist);
test.after(() => cleanup(dist));

// Fixture corpus expectations, kept explicit so a corpus change is a visible edit.
const PUBLISHED = [
  { slug: "welcome", title: "Setting up", tags: ["meta"], math: true },
  { slug: "markdown-kitchen-sink", title: "Markdown kitchen sink", tags: ["markdown", "testing"], math: true },
  { slug: "latex-note", title: "A LaTeX-sourced note", tags: ["latex", "testing"], math: true },
  { slug: "untagged", title: "A post with no tags", tags: [], math: false },
  { slug: "embeds", title: "Per-post embed hooks", tags: ["testing"], math: false },
  { slug: "same-date-alpha", title: "Same date, alpha", tags: ["testing"], math: false },
  { slug: "same-date-beta", title: "Same date, beta", tags: ["testing"], math: false },
];

test("every published post emits <slug>/index.html", () => {
  for (const { slug } of PUBLISHED) {
    assert.ok(files.includes(`${slug}/index.html`), `missing page for ${slug}`);
  }
});

test("draft posts emit nothing at all", () => {
  const leaked = files.filter((f) => {
    if (!/\.(html|xml|txt)$/.test(f)) return false;
    return read(f).includes("Never published") || read(f).includes("draft exclusion is broken");
  });
  assert.deepEqual(leaked, [], "draft content leaked into the build");
  assert.ok(!files.includes("draft/index.html"));
});

test("every distinct tag emits a page listing exactly its posts", () => {
  const tags = new Map();
  for (const p of PUBLISHED) for (const t of p.tags) {
    if (!tags.has(t)) tags.set(t, []);
    tags.get(t).push(p.title);
  }
  for (const [tag, titles] of tags) {
    const rel = `tags/${tag}/index.html`;
    assert.ok(files.includes(rel), `missing tag page for ${tag}`);
    const html = read(rel);
    for (const title of titles) assert.ok(html.includes(title), `${rel} omits ${title}`);
    for (const p of PUBLISHED) {
      if (!p.tags.includes(tag)) {
        assert.ok(!html.includes(`>${p.title}<`), `${rel} wrongly lists ${p.title}`);
      }
    }
  }
});

test("listings are newest-first", () => {
  const html = read("index.html");
  const order = PUBLISHED
    .map((p) => ({ slug: p.slug, at: html.indexOf(`/${p.slug}/`) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.slug);
  const byDate = ["same-date-beta", "same-date-alpha", "embeds", "untagged", "latex-note", "markdown-kitchen-sink", "welcome"];
  // Same-date pair may appear in either relative order until a tie-breaker exists.
  const normalize = (xs) => xs.filter((s) => !s.startsWith("same-date"));
  assert.deepEqual(normalize(order), normalize(byDate));
});

test("canonical URL matches the path the page is emitted at", () => {
  for (const { slug } of PUBLISHED) {
    const html = read(`${slug}/index.html`);
    const m = html.match(/<link rel="canonical" href="([^"]+)"/);
    assert.ok(m, `${slug} has no canonical link`);
    assert.ok(
      m[1].endsWith(`/${slug}/`),
      `${slug} canonical ${m[1]} does not match its emitted path (trailingSlash is on in vercel.json)`
    );
  }
});

test("required site files are all present", () => {
  for (const rel of [
    "index.html", "404.html", "robots.txt", "sitemap.xml", "feed.xml",
    "favicon.svg", "styles/blog.css", "styles/katex.min.css", "assets/blog.js",
  ]) {
    assert.ok(files.includes(rel), `missing ${rel}`);
  }
  assert.ok(files.some((f) => f.startsWith("styles/fonts/")), "KaTeX fonts were not copied");
});

test("the sitemap lists every post URL and every tag URL exactly once", () => {
  const xml = read("sitemap.xml");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(new Set(locs).size, locs.length, "sitemap contains duplicate <loc> entries");
  for (const { slug } of PUBLISHED) {
    assert.equal(locs.filter((l) => l.endsWith(`/${slug}/`)).length, 1, `sitemap missing ${slug}`);
  }
  for (const tag of ["meta", "markdown", "testing", "latex"]) {
    assert.equal(locs.filter((l) => l.endsWith(`/tags/${tag}/`)).length, 1, `sitemap missing tag ${tag}`);
  }
});

test("the feed carries one item per published post", () => {
  const xml = read("feed.xml");
  assert.equal((xml.match(/<item>/g) || []).length, PUBLISHED.length);
  const guids = [...xml.matchAll(/<guid[^>]*>([^<]+)<\/guid>/g)].map((m) => m[1]);
  assert.equal(new Set(guids).size, guids.length, "duplicate RSS GUIDs");
  for (const g of guids) assert.match(g, /^https:\/\//, "RSS GUID is not an absolute URL");
});

test("KaTeX stylesheet is linked by exactly the posts that need it", () => {
  for (const { slug, math } of PUBLISHED) {
    const linked = read(`${slug}/index.html`).includes("/styles/katex.min.css");
    assert.equal(linked, math, `${slug}: expected KaTeX CSS linked=${math}, got ${linked}`);
  }
});
