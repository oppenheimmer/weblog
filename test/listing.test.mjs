// Tier 2 — the listing model and the markup edits that let posts share a page
// (CLAUDE.md Step 8).
//
// Run against real renderer output wherever it matters, because the rewriter's
// whole job is to leave KaTeX, highlight.js and unified-latex output alone
// except for exactly the attributes it means to change.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { rewriteStartTags, prepareArticle, definedIds, containsElement } from "../lib/markup.mjs";
import { paginate, pagePath, listingPages, inlinesInFeed, FEED_PAGE_BYTES } from "../lib/listing.mjs";
import { loadPost } from "../lib/content.mjs";
import { md, mdBrowser } from "../lib/markdown.mjs";
import { renderLatex } from "../lib/latex.mjs";
import { ENGINE } from "../lib/sanitize.mjs";
import { FIXTURES } from "./helpers/build-fixture.mjs";

const POSTS = path.join(FIXTURES, "content", "posts");
const fixtureHtml = () => fs.readdirSync(POSTS).flatMap((file) => {
  const raw = fs.readFileSync(path.join(POSTS, file), "utf8").replace(/^---[\s\S]*?---/, "");
  return file.endsWith(".tex")
    ? [renderLatex(raw), renderLatex(raw, { trust: ENGINE })]
    : [md.render(raw), mdBrowser.render(raw)];
});

// ------------------------------------------------------------------ tokenizer

test("a rewrite that edits nothing returns every byte it was given", () => {
  const awkward = [
    `<script>if (a<b && c>d) { s = "<a id='x'>"; }</script>`,
    `<style>p > a[id="x"] { color: red }</style>`,
    `<!-- <a id="commented"> --><![CDATA[ <b id="c"> ]]>`,
    `<p title="a > b" data-x='"q"' hidden class ="k" id = spaced>t</p>`,
    `<textarea><a id="inside"></textarea><br/><img src=/u.png/>`,
    `1 < 2 and <3 and a<b`,
  ].join("\n");
  for (const html of [...fixtureHtml(), awkward]) {
    let tags = 0;
    const out = rewriteStartTags(html, (tag) => { tags++; tag.get("id"); tag.has("src"); });
    assert.equal(out, html);
    assert.ok(tags > 0 || !html.includes("<"), "the visitor never ran");
  }
});

test("only real start tags are seen — not comments, raw text, or text that looks like markup", () => {
  const names = [];
  rewriteStartTags(
    // The comment holds a ">" before its tag, so only real comment handling —
    // not a skip to the next ">" — keeps that tag out.
    `<!-- a > b <a id="c"> --><script>var t = "<b id='s'>";</script><p class ="k">1 < 2</p><textarea><i id="t"></textarea>`,
    (tag) => names.push(`${tag.name}#${tag.get("id") ?? ""}.${tag.get("class") ?? ""}`)
  );
  assert.deepEqual(names, ["script#.", "p#.k", "textarea#."]);

  // As the HTML parser reads it: in HTML content "<![CDATA[" opens a bogus
  // comment that ends at the first ">", so the tag after it is real.
  const after = [];
  rewriteStartTags(`<![CDATA[ x > <b id="d"> ]]>`, (tag) => after.push(`${tag.name}#${tag.get("id")}`));
  assert.deepEqual(after, ["b#d"]);
});

test("set() will not write a value that could escape its quoting", () => {
  const edit = (html, name, value) => rewriteStartTags(html, (tag) => tag.set(name, value));
  assert.throws(() => edit(`<a id="x">`, "id", `x" onclick="alert(1)`), /unescaped/);
  assert.throws(() => edit(`<a id='x'>`, "id", `x' onclick='alert(1)`), /unescaped/);
  assert.throws(() => edit(`<a id=x>`, "id", "x onclick=alert(1)"), /unescaped/);
  assert.throws(() => edit(`<img src="/a.png">`, "alt", `"><script>`), /unescaped/);
  assert.equal(edit(`<a id='x'>`, "id", `say "hi"`), `<a id='say "hi"'>`);
});

// ---------------------------------------------------------------- namespacing

test("every id a post defines is prefixed, and links to those ids follow", () => {
  const html = mdBrowser.render("## Intro\n\nSee [below](#intro-1).\n\n## Intro\n\nBack to [the top](#intro).");
  const out = prepareArticle(html, { idPrefix: "a-post" });
  assert.deepEqual([...definedIds(out)], ["a-post--intro", "a-post--intro-1"]);
  assert.match(out, /<a href="#a-post--intro-1">below<\/a>/);
  assert.match(out, /<a href="#a-post--intro">the top<\/a>/);
  assert.deepEqual([...definedIds(html)], ["intro", "intro-1"], "the input was modified");
});

test("links to ids the post does not define are left alone", () => {
  const html = mdBrowser.render("## Intro\n\n[skip](#main-content) [nowhere](#missing) [elsewhere](/other/#intro)");
  const out = prepareArticle(html, { idPrefix: "p" });
  assert.match(out, /href="#main-content"/);
  assert.match(out, /href="#missing"/);
  assert.match(out, /href="\/other\/#intro"/);
});

test("code, and LaTeX prose that looks like an attribute, are text and stay text", () => {
  const markdown = mdBrowser.render('## x\n\n`id="x"` and\n\n```html\n<a href="#x" id="x">\n```');
  const prefixed = prepareArticle(markdown, { idPrefix: "p" });
  assert.equal((prefixed.match(/p--x/g) ?? []).length, 2, "the heading and its permalink, and nothing in the code");
  assert.equal(prefixed.replace('id="p--x"', 'id="x"').replace('href="#p--x"', 'href="#x"'), markdown);

  // hast-util-to-html does not escape quotes in text, so this really is `id="x"` in the output.
  const latex = renderLatex('\\section{x} \\texttt{id="x" href="\\#x"}');
  const out = prepareArticle(latex, { idPrefix: "p" });
  assert.equal(out, latex, "text in a LaTeX post was rewritten as if it were markup");
});

test("references by id list, label, and SVG url() all follow a renamed id", () => {
  const html = `<svg><defs><linearGradient id="g"></linearGradient></defs>` +
    `<rect fill="url(#g)" style="fill: url('#g')"></rect></svg>` +
    `<label for="name">Name</label><input id="name" aria-describedby="name hint">`;
  const out = prepareArticle(html, { idPrefix: "s" });
  assert.match(out, /id="s--g"/);
  assert.match(out, /fill="url\(#s--g\)"/);
  assert.match(out, /style="fill: url\('#s--g'\)"/);
  assert.match(out, /for="s--name"/);
  assert.match(out, /aria-describedby="s--name hint"/, "an undefined id in a list was renamed, or a defined one was not");
});

test("section permalinks from a listing go to the post's own page, under the id it has there", () => {
  // "Why this blog?" slugs to "why-this-blog". Heading ids come from the site's
  // own slugify, which drops punctuation rather than percent-encoding it, so
  // the fragment is readable and cannot contain the "--" that namespaces ids.
  const html = mdBrowser.render("## Why this blog?\n\n[inline](#why-this-blog)");
  const out = prepareArticle(html, {
    idPrefix: "welcome",
    permalinks: { className: "heading-anchor", base: "/welcome/" },
  });
  assert.match(out, /<a class="heading-anchor" href="\/welcome\/#why-this-blog"/);
  assert.match(out, /<a href="#welcome--why-this-blog">inline<\/a>/, "an ordinary link was treated as a permalink");
  assert.ok(definedIds(html).has("why-this-blog"), "the post page does not define the id the permalink targets");
});

test("the id prefix must be a slug, which is what makes prefixed ids collision-free", () => {
  for (const bad of ["", "a--b", "-a", "a-", "A", "a b", 'a"'])
    assert.throws(() => prepareArticle("<h2 id=x>", { idPrefix: bad }), /usable id prefix/, bad);
});

test("identical headings in two posts cannot collide once prefixed", () => {
  const body = "## Introduction\n\n## Results\n\n## Introduction";
  const a = definedIds(prepareArticle(mdBrowser.render(body), { idPrefix: "a" }));
  const b = definedIds(prepareArticle(mdBrowser.render(body), { idPrefix: "a-b" }));
  assert.equal(a.size, 3);
  assert.deepEqual([...a].filter((id) => b.has(id)), []);
});

// ------------------------------------------------------------------- images

test("images named in the media manifest get their dimensions, and nothing else does", () => {
  const html = `<img src="/images/uploads/p/a.png" alt="a">` +
    `<img src="/images/uploads/p/b.png" alt="b" width="1" height="2">` +
    `<img src="/images/elsewhere.png" alt="c">` +
    `<img src="/images/uploads/p/bad.png" alt="d">`;
  const sizes = new Map([
    ["/images/uploads/p/a.png", { width: 640, height: 480 }],
    ["/images/uploads/p/b.png", { width: 640, height: 480 }],
    ["/images/uploads/p/bad.png", { width: "640\" onload=\"x", height: -1 }],
  ]);
  const out = prepareArticle(html, { sizes });
  assert.match(out, /<img src="\/images\/uploads\/p\/a\.png" alt="a" width="640" height="480">/);
  assert.match(out, /<img src="\/images\/uploads\/p\/b\.png" alt="b" width="1" height="2">/, "authored dimensions were overridden");
  assert.match(out, /<img src="\/images\/elsewhere\.png" alt="c">/);
  assert.match(out, /<img src="\/images\/uploads\/p\/bad\.png" alt="d">/, "a malformed manifest entry reached the markup");
});

test("lazy loading is added only when asked, and never over an explicit choice", () => {
  const html = `<img src="/a.png"><img src="/b.png" loading="eager">`;
  assert.equal(prepareArticle(html), html);
  assert.equal(prepareArticle(html, { lazy: true }), `<img src="/a.png" loading="lazy"><img src="/b.png" loading="eager">`);
});

test("a body with nothing to change comes back as the very same string", () => {
  for (const html of fixtureHtml()) assert.equal(prepareArticle(html, { sizes: new Map() }), html);
});

// ------------------------------------------------------------------ pagination

const weights = (pages) => pages.map((page) => page.reduce((sum, w) => sum + w, 0));

test("pages keep order, lose nothing, and stay within budget unless one post is heavier than all of it", () => {
  const items = [120, 90, 200, 10, 10, 10, 500, 30, 70, 100, 1];
  const pages = paginate(items, { budget: 200, weigh: (w) => w });
  assert.deepEqual(pages.flat(), items);
  assert.ok(pages.every((page) => page.length > 0), "an empty page was produced");
  weights(pages).forEach((total, i) => {
    assert.ok(total <= 200 || pages[i].length === 1, `page ${i + 1} weighs ${total}`);
  });
  assert.deepEqual(pages, [[120], [90], [200], [10, 10, 10], [500], [30, 70, 100], [1]]);
});

test("pagination is greedy: a page is only closed by the item that would overflow it", () => {
  const pages = paginate([100, 100, 1], { budget: 200, weigh: (w) => w });
  assert.deepEqual(pages, [[100, 100], [1]]);
});

test("an empty scope is one empty page, so a listing always has a first page", () => {
  assert.deepEqual(paginate([], { weigh: () => 1 }), [[]]);
  assert.throws(() => paginate([1], { budget: 0, weigh: () => 1 }), /positive/);
});

test("page URLs: the first page is the listing itself, never /page/1/", () => {
  assert.equal(pagePath("/", 1), "/");
  assert.equal(pagePath("/", 2), "/page/2/");
  assert.equal(pagePath("/tags/ml/", 3), "/tags/ml/page/3/");

  const pages = listingPages(["a", "b", "c"], { base: "/tags/x/", budget: 1, weigh: () => 1 });
  assert.deepEqual(pages.map((p) => [p.path, p.newer, p.older, p.count]), [
    ["/tags/x/", null, "/tags/x/page/2/", 3],
    ["/tags/x/page/2/", "/tags/x/", "/tags/x/page/3/", 3],
    ["/tags/x/page/3/", "/tags/x/page/2/", null, 3],
  ]);
});

test("the default budget holds a few long mathematical posts, not dozens and not one", () => {
  // The number is a measured decision (lib/listing.mjs); this keeps it from
  // drifting into a value that contradicts the reasoning recorded beside it.
  // Ten displayed equations and thirty inline expressions among prose: the
  // shape of a long technical post, which the budget was measured against.
  const inline = (i) => `$\\mathcal{L}_{${i}}(\\theta)$`;
  const body = Array.from({ length: 10 }, (_, i) =>
    `Words about the model ${inline(i)} and its loss ${inline(i + 1)} over the data ${inline(i + 2)}.\n\n` +
    `$$\\sum_{k=1}^{n} \\frac{x_k^{${i}}}{\\sqrt{k}} = \\int_0^1 f(t)\\,dt$$`).join("\n\n");
  const post = loadPost(`---\ntitle: M\ndate: 2026-01-01\n---\n\n${body}`, { sourceName: "m.md" });
  const perPage = Math.floor(FEED_PAGE_BYTES / Buffer.byteLength(post.html));
  assert.ok(perPage >= 2 && perPage <= 6, `the budget fits ${perPage} such posts per page`);
});

// ------------------------------------------------------------------- embeds

test("a post whose code needs the page to itself is not inlined into the feed", () => {
  const plain = loadPost("---\ntitle: P\ndate: 2026-01-01\n---\n\nHello `<script>` in code.", { sourceName: "p.md" });
  assert.equal(inlinesInFeed(plain), true, "escaped text that mentions script was mistaken for a script");

  for (const hook of [{ scripts: ["/a.js"] }, { styles: ["/a.css"] }, { head: "<meta x>" }, { distill: true }]) {
    assert.equal(inlinesInFeed({ ...plain, ...hook }), false, JSON.stringify(hook));
  }
  for (const element of ["<script>x()</script>", "<style>p{}</style>", '<link rel="stylesheet" href="/x.css">', '<base href="/">']) {
    const raw = loadPost(`---\ntitle: R\ndate: 2026-01-01\n---\n\n${element}\n\ntext`, { sourceName: "r.md", trust: ENGINE });
    assert.equal(inlinesInFeed(raw), false, element);
  }
  assert.equal(containsElement("<p>&lt;script&gt;</p>", ["script"]), false);
});
