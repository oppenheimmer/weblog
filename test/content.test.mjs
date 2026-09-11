// Tier 2 — the shared content pipeline.
//
// The point of lib/content.mjs is that it renders posts with no filesystem
// involved, so the R2 reader and the editor's preview can use the same code the
// build uses (CLAUDE.md §1.1, §3.2). These tests drive it purely from strings.
import test from "node:test";
import assert from "node:assert/strict";
import {
  loadPost, parseSource, normalizePost, derivePostSlug, formatFromFilename,
  assertUniqueSlugs, sortPosts, collectPosts, groupByTag,
  ContentError, RESERVED_SLUGS,
} from "../lib/content.mjs";

const doc = (front, body) => `---\n${front}\n---\n\n${body}\n`;

/** assert.throws() returns undefined, so capture the error when we need to inspect it. */
function catches(fn, message) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail(message || "expected the call to throw, but it returned normally");
}
const basic = (extra = "") => doc(`title: "A post"\ndate: 2026-07-01${extra ? "\n" + extra : ""}`, "Body text.");

test("renders a post from a string with no filesystem access", () => {
  const post = loadPost(basic(), { sourceName: "2026-07-01-a-post.md" });
  assert.equal(post.slug, "a-post");
  assert.equal(post.title, "A post");
  assert.equal(post.date, "2026-07-01T00:00:00.000Z");
  assert.match(post.html, /<p>Body text\.<\/p>/);
});

test("format can be given explicitly, for sources that have no filename", () => {
  const tex = loadPost(doc('title: "T"\ndate: 2026-07-01', "\\section{Hello}"), {
    sourceName: "from-r2",
    format: "latex",
  });
  assert.match(tex.html, /Hello/);
  assert.ok(!tex.html.includes("\\section"), "LaTeX source leaked into output unrendered");
});

test("format inference follows the extension", () => {
  assert.equal(formatFromFilename("a.tex"), "latex");
  assert.equal(formatFromFilename("a.md"), "markdown");
  assert.equal(formatFromFilename("no-extension"), "markdown");
});

test("an unknown format is rejected rather than silently treated as Markdown", () => {
  assert.throws(
    () => normalizePost({ data: { title: "T", date: "2026-07-01" }, body: "x", format: "docx" }),
    ContentError
  );
});

test("drafts are an exclusion, not an error", () => {
  assert.equal(loadPost(basic("draft: true"), { sourceName: "d.md" }), null);
});

test("missing title or date is reported against the source", () => {
  for (const front of ['title: "Only a title"', "date: 2026-07-01"]) {
    const err = catches(() => loadPost(doc(front, "Body."), { sourceName: "broken.md" }));
    assert.ok(err instanceof ContentError);
    assert.match(err.message, /broken\.md/);
    assert.match(err.message, /title and date/);
  }
});

test("an unparseable date is rejected instead of producing an Invalid Date page", () => {
  const err = catches(() => loadPost(doc('title: "T"\ndate: "not-a-date"', "Body."), { sourceName: "bad-date.md" }));
  assert.ok(err instanceof ContentError);
  assert.equal(err.field, "date");
});

test("reserved slugs are rejected so posts cannot shadow generated routes", () => {
  // "page" because listings continue at /page/2/ (lib/listing.mjs).
  for (const reserved of ["tags", "api", "editor", "login", "404", "images", "downloads", "page"]) {
    assert.ok(RESERVED_SLUGS.has(reserved), `${reserved} should be reserved`);
    const err = catches(
      () => loadPost(basic(`slug: ${reserved}`), { sourceName: "x.md" }),
      `slug "${reserved}" was accepted`
    );
    assert.ok(err instanceof ContentError);
    assert.match(err.message, /reserved slug/);
  }
});

test("a source that reduces to an empty slug is rejected", () => {
  assert.throws(() => loadPost(basic(), { sourceName: "2026-07-01-.md" }), ContentError);
});

test("slug derivation drops the date prefix and honours explicit frontmatter", () => {
  assert.equal(derivePostSlug({ filename: "2026-07-01-hello-world.md" }), "hello-world");
  assert.equal(derivePostSlug({ filename: "no-date-prefix.tex" }), "no-date-prefix");
  assert.equal(derivePostSlug({ filename: "x.md", frontmatterSlug: "Custom Slug" }), "custom-slug");
});

test("duplicate slugs are refused with both sources named", () => {
  const posts = [
    { slug: "dup", sourceFile: "2026-01-01-dup.md", date: "2026-01-01T00:00:00.000Z", tags: [] },
    { slug: "dup", sourceFile: "2026-02-02-dup.md", date: "2026-02-02T00:00:00.000Z", tags: [] },
  ];
  const err = catches(() => assertUniqueSlugs(posts));
  assert.ok(err instanceof ContentError);
  assert.match(err.message, /2026-01-01-dup\.md/);
  assert.match(err.message, /2026-02-02-dup\.md/);
});

test("ordering is newest first and deterministic for equal dates", () => {
  const at = (slug, date) => ({ slug, date, sourceFile: slug, tags: [] });
  const sorted = sortPosts([
    at("beta", "2026-07-06T00:00:00.000Z"),
    at("older", "2026-01-01T00:00:00.000Z"),
    at("alpha", "2026-07-06T00:00:00.000Z"),
  ]).map((p) => p.slug);
  assert.deepEqual(sorted, ["alpha", "beta", "older"]);

  // Input order must not change the result, or builds differ by machine.
  const reversed = sortPosts([
    at("alpha", "2026-07-06T00:00:00.000Z"),
    at("beta", "2026-07-06T00:00:00.000Z"),
    at("older", "2026-01-01T00:00:00.000Z"),
  ]).map((p) => p.slug);
  assert.deepEqual(reversed, sorted);
});

test("collectPosts validates and orders in one call", () => {
  const posts = collectPosts([
    { slug: "b", date: "2026-01-01T00:00:00.000Z", sourceFile: "b", tags: [] },
    { slug: "a", date: "2026-02-02T00:00:00.000Z", sourceFile: "a", tags: [] },
  ]);
  assert.deepEqual(posts.map((p) => p.slug), ["a", "b"]);
});

test("tag grouping preserves the order posts were given in", () => {
  const tags = groupByTag([
    { slug: "first", tags: ["Machine Learning", "meta"] },
    { slug: "second", tags: ["machine-learning"] },
  ]);
  assert.deepEqual([...tags.keys()].sort(), ["machine-learning", "meta"]);
  assert.deepEqual(tags.get("machine-learning").posts.map((p) => p.slug), ["first", "second"]);
});

test("frontmatter parses away from the body for both formats", () => {
  const { data, body } = parseSource(doc('title: "T"\ndate: 2026-07-01\ntags: [a, b]', "The body."));
  assert.equal(data.title, "T");
  assert.deepEqual(data.tags, ["a", "b"]);
  assert.match(body, /The body\./);
  assert.ok(!body.includes("title:"), "frontmatter leaked into the body");
});

test("embed hooks default to safe empty values", () => {
  const post = loadPost(basic(), { sourceName: "x.md" });
  assert.deepEqual(post.styles, []);
  assert.deepEqual(post.scripts, []);
  assert.equal(post.head, "");
  assert.equal(post.distill, false);
});
