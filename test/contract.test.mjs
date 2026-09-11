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

// ---- Listings: feed and table (CLAUDE.md Step 8) --------------------------
//
// Parsed with patterns written against the emitted markup, not with the
// rewriter that produced it, so a bug there cannot hide behind its own help.

const htmlPages = files.filter((f) => f.endsWith(".html"));
const NEWEST_FIRST = ["same-date-alpha", "same-date-beta", "embeds", "untagged", "latex-note", "markdown-kitchen-sink", "welcome"];
const feedSlugs = (html) => [...html.matchAll(/<h2 class="feed-title"><a href="\/([^/]+)\/">/g)].map((m) => m[1]);
const tableSlugs = (html) => [...html.matchAll(/<th scope="row" class="post-table-title"><a href="\/([^/]+)\/">/g)].map((m) => m[1]);
const idsOf = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

test("the feed and the table show the same posts in the same order, newest first", () => {
  const home = read("index.html");
  assert.deepEqual(feedSlugs(home), NEWEST_FIRST);
  assert.deepEqual(tableSlugs(home), NEWEST_FIRST);
});

test("on every tag page both views show exactly the tagged posts, in the same order", () => {
  for (const tag of ["meta", "markdown", "testing", "latex"]) {
    const html = read(`tags/${tag}/index.html`);
    const expected = NEWEST_FIRST.filter((slug) => PUBLISHED.find((p) => p.slug === slug).tags.includes(tag));
    assert.deepEqual(feedSlugs(html), expected, `feed on tags/${tag}`);
    assert.deepEqual(tableSlugs(html), expected, `table on tags/${tag}`);
  }
});

test("the table is a native table whose columns are Title, Date and Tags", () => {
  const html = read("index.html");
  assert.match(html, /<thead>\s*<tr><th scope="col">Title<\/th><th scope="col">Date<\/th><th scope="col">Tags<\/th><\/tr>/);
  assert.ok(!/role="(table|row|cell|columnheader)"/.test(html), "ARIA table roles left over from the div table");
});

test("no page carries a duplicate id, and every same-page link lands on one", () => {
  for (const rel of htmlPages) {
    const html = read(rel);
    const ids = idsOf(html);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dupes, [], `${rel} repeats ids`);
    const known = new Set(ids);
    const dangling = [...html.matchAll(/\shref="#([^"]*)"/g)].map((m) => m[1]).filter((id) => !known.has(id));
    assert.deepEqual(dangling, [], `${rel} links to ids it does not have`);
  }
});

test("section links in the feed go to an id that exists on the post's own page", () => {
  const links = [...read("index.html").matchAll(/\shref="\/([a-z0-9-]+)\/#([^"]+)"/g)];
  assert.ok(links.length >= 4, "the fixture feed has headings, so it should have section links");
  for (const [, slug, id] of links) {
    assert.ok(idsOf(read(`${slug}/index.html`)).includes(id), `/${slug}/#${id} goes nowhere`);
  }
});

test("each article in the feed is its post page's body, differing only by namespacing and lazy images", () => {
  const home = read("index.html");
  for (const slug of NEWEST_FIRST.filter((s) => s !== "embeds")) {
    const article = home.match(new RegExp(`<a href="/${slug}/">[\\s\\S]*?<div class="prose">\\n([\\s\\S]*?)\\n {12}</div>\\n {10}</article>`));
    assert.ok(article, `no feed article for ${slug}`);
    const page = read(`${slug}/index.html`).match(/<div class="prose fade-up">\n([\s\S]*?)\n {8}<\/div>\n {6}<\/div>\n {4}<\/article>/);
    const restored = article[1]
      .replaceAll(` id="${slug}--`, ' id="')
      .replaceAll(` href="#${slug}--`, ' href="#')
      .replaceAll(` href="/${slug}/#`, ' href="#')
      .replaceAll(' loading="lazy"', "");
    assert.equal(restored, page[1], `the feed changed more than ids in ${slug}`);
  }
});

test("images wait to load in articles further down a feed page, never in the first", () => {
  // The kitchen sink is sixth on the home page and first on its tag page.
  const image = (html) => html.match(/<img src="\/images\/diagram\.png"[^>]*>/)?.[0];
  assert.match(image(read("index.html")), /loading="lazy"/, "a feed image far down the page loads eagerly");
  assert.doesNotMatch(image(read("tags/markdown/index.html")), /loading=/, "the first article's image is lazy, delaying the largest paint");
  assert.doesNotMatch(image(read("markdown-kitchen-sink/index.html")), /loading=/, "the post page changed how its images load");
});

test("per-post embeds never load on a listing; that post is summarised and linked", () => {
  for (const rel of ["index.html", "tags/testing/index.html"]) {
    const html = read(rel);
    for (const marker of ["/assets/posts/embeds/fig.js", "/assets/posts/embeds/fig.css", "distill.template", "fixture-head", 'id="custom-embed"']) {
      assert.ok(!html.includes(marker), `${rel} loads ${marker}`);
    }
    assert.match(html, /<a class="button button-secondary" href="\/embeds\/">Read the post<\/a>/);
  }
  assert.ok(read("embeds/index.html").includes("/assets/posts/embeds/fig.js"), "the post's own page lost its embed");
});

test("listing pages choose their view before the body; post pages carry no view script", () => {
  assert.match(read("index.html"), /<head>[\s\S]*localStorage\.getItem\("blog:view"\)[\s\S]*<\/head>/);
  assert.ok(!read("welcome/index.html").includes("blog:view"));
  for (const rel of ["index.html", "tags/testing/index.html"]) {
    const canonical = read(rel).match(/<link rel="canonical" href="([^"]+)"/)[1];
    assert.ok(!canonical.includes("?"), `${rel} canonical carries a query: ${canonical}`);
  }
});

// ---- Pagination, with a budget small enough to put one post on each page ----

test("a paginated build splits every listing by weight and keeps both views whole", () => {
  const paged = buildFixtures({ env: { BLOG_FEED_PAGE_BYTES: "1" } });
  try {
    const pread = (rel) => fs.readFileSync(path.join(paged, rel), "utf8");
    const pfiles = walk(paged);
    assert.ok(!pfiles.some((f) => /(^|\/)page\/1\//.test(f)), "a /page/1/ duplicate of the first page was emitted");

    const scopes = [
      { base: "", slugs: NEWEST_FIRST },
      { base: "tags/testing/", slugs: NEWEST_FIRST.filter((s) => PUBLISHED.find((p) => p.slug === s).tags.includes("testing")) },
    ];
    for (const { base, slugs } of scopes) {
      const pagePaths = slugs.map((_, i) => (i === 0 ? base : `${base}page/${i + 1}/`));
      const seen = [];
      pagePaths.forEach((rel, i) => {
        const html = pread(`${rel}index.html`);
        seen.push(...feedSlugs(html));
        assert.deepEqual(tableSlugs(html), slugs, `${rel || "/"}: the table must list the whole scope`);
        assert.match(html, new RegExp(`<link rel="canonical" href="https://blog\\.souravmishra\\.net/${rel}" />`));
        assert.equal(/rel="prev"/.test(html), i > 0, `${rel}: newer link`);
        assert.equal(/rel="next"/.test(html), i < pagePaths.length - 1, `${rel}: older link`);
        if (i > 0) assert.ok(html.includes(`href="/${pagePaths[i - 1]}" rel="prev"`), `${rel}: newer link goes to the wrong page`);
        if (i > 0) assert.match(html, new RegExp(`<title>[^<]*page ${i + 1}[^<]*</title>`, "i"));

        // KaTeX is linked by exactly the pages whose article needs it.
        const post = PUBLISHED.find((p) => p.slug === feedSlugs(html)[0]);
        assert.equal(html.includes("/styles/katex.min.css"), post.math && post.slug !== "embeds", `${rel}: math gating`);
      });
      assert.deepEqual(seen, slugs, `${base || "home"}: the feed pages together must show every post once, in order`);
      assert.ok(!pfiles.includes(`${base}page/${slugs.length + 1}/index.html`), "an extra empty page was emitted");
    }

    // Pagination adds listing pages and changes nothing a subscriber or crawler relies on.
    for (const rel of ["feed.xml", "sitemap.xml", "welcome/index.html"]) {
      assert.equal(pread(rel), read(rel), `${rel} changed when only pagination did`);
    }
  } finally {
    cleanup(paged);
  }
});
