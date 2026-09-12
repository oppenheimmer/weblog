// Tier 2 and Tier 4 — the interactive bundle contract (CLAUDE.md §3.6).
//
// A bundle is the first thing this system will publish that the owner wrote as
// *code* rather than as prose, so the contract is the place where "what may be
// published" is decided. These tests weight towards refusals: a manifest that
// should not exist must be rejected here, before any byte is stored, because
// every later stage treats a validated manifest as trustworthy.
import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";

import {
  validateManifest, normalizeBundlePath, bundleTypeFor, computeRevisionId,
  sanitizeInteractiveName, publicBundlePath, publicFileUrl, extensionOf,
  InteractiveError, LIMITS, INTERACTIVE_REVISION_PATTERN, VENDORED_DEPENDENCIES,
  VENDORED_SOURCES,
} from "../lib/interactives.mjs";
import { ROOT } from "./helpers/build-fixture.mjs";

const POST = "p_00000000000000aa";
const hash = (n) => String(n).repeat(64).slice(0, 64);

const file = (name, over = {}) => ({ name, bytes: 10, sha256: hash(1), ...over });

const demo = (over = {}) => ({
  kind: "demo", postId: POST, name: "orbit",
  entry: "index.html", fallback: "fallback.html",
  files: [file("index.html"), file("fallback.html"), file("demo.mjs"), file("data.json")],
  ...over,
});

const figure = (over = {}) => ({
  kind: "figure", postId: POST, name: "loss-surface",
  entry: "main.mjs", fallback: "fallback.html",
  files: [file("main.mjs"), file("fallback.html"), file("style.css")],
  ...over,
});

/** The refusal a manifest earns, or a failure naming what got through. */
function refusal(input, options) {
  try {
    validateManifest(input, options);
  } catch (err) {
    assert.ok(err instanceof InteractiveError, `threw a ${err.name}, not a refusal`);
    return err;
  }
  assert.fail("the manifest was accepted");
}

// ------------------------------------------------------------ the happy path

test("a lab and a figure both validate, and come back normalized", () => {
  const lab = validateManifest(demo());
  assert.equal(lab.kind, "demo");
  assert.equal(lab.entry, "index.html");
  assert.equal(lab.bytes, 40);
  // Ordered, so two pushes of the same folder produce the same manifest.
  assert.deepEqual(lab.files.map((f) => f.name), ["data.json", "demo.mjs", "fallback.html", "index.html"]);
  // Served as what its name says, which is what makes relative imports work.
  assert.equal(lab.files.find((f) => f.name === "demo.mjs").type, "text/javascript; charset=utf-8");

  const fig = validateManifest(figure());
  assert.equal(fig.kind, "figure");
  assert.equal(fig.entry, "main.mjs");
});

test("a bundle keeps its own directory structure", () => {
  // §3.6: index.html may say ./demo.js and that script may read ./data.json,
  // whatever the R2 prefix above it is called. Nested paths survive intact.
  const manifest = validateManifest(demo({
    files: [file("index.html"), file("fallback.html"), file("lib/plot/draw.mjs"), file("lib/data.json")],
  }));
  assert.deepEqual(
    manifest.files.map((f) => f.name),
    ["fallback.html", "index.html", "lib/data.json", "lib/plot/draw.mjs"]
  );
});

test("a public name is readable, and a public path is readable and immutable", () => {
  assert.equal(sanitizeInteractiveName("Orbit Explorer!"), "orbit-explorer");
  // The accent defect Step 4 found, in the module that inherited the rule.
  assert.equal(sanitizeInteractiveName("ünïcödé"), "unicode");
  assert.equal(sanitizeInteractiveName(""), "interactive");

  assert.equal(publicBundlePath("demo", "a-post", "orbit", "iv_1"), "/demos/a-post/orbit/iv_1/");
  assert.equal(
    publicFileUrl("figure", "a-post", "loss", "iv_1", "main.mjs"),
    "/assets/figures/a-post/loss/iv_1/main.mjs"
  );
  // Labs get their own prefix so a response header can sandbox them without
  // touching images or figures — the whole reason the paths differ.
  assert.ok(publicBundlePath("demo", "s", "n", "iv_1").startsWith("/demos/"));
  assert.ok(!publicBundlePath("figure", "s", "n", "iv_1").startsWith("/demos/"));
});

// ------------------------------------------------------- revision by content

test("a revision id is a fact about the bundle's contents", () => {
  const first = computeRevisionId(validateManifest(demo()));
  assert.match(first, INTERACTIVE_REVISION_PATTERN);

  // Re-pushing an unchanged folder lands on the revision already stored.
  assert.equal(computeRevisionId(validateManifest(demo())), first);

  // One changed byte is a new revision, never an edit to the one readers have.
  const changed = computeRevisionId(validateManifest(demo({
    files: [file("index.html"), file("fallback.html"), file("demo.mjs", { sha256: hash(2) }), file("data.json")],
  })));
  assert.notEqual(changed, first);
});

test("a revision id does not move when only the name or owner does", () => {
  // The name is a public label and the post id is ownership; neither changes
  // the bytes, so neither should orphan a stored revision.
  const base = computeRevisionId(validateManifest(demo()));
  assert.equal(computeRevisionId(validateManifest(demo({ name: "something-else" }))), base);
  assert.equal(computeRevisionId(validateManifest(demo({ postId: "p_00000000000000bb" }))), base);
});

// --------------------------------------------------------------- path safety

test("a bundle cannot name anything outside itself", () => {
  const outside = [
    "../secrets.json", "a/../../b.js", "..", "./x.js", "/etc/passwd",
    "sub\\win.js", "//host/x.js", "a//b.js", "",
  ];
  for (const path of outside) {
    assert.throws(() => normalizeBundlePath(path), InteractiveError, `"${path}" was accepted`);
  }
});

test("traversal in a bundle is refused, never repaired", () => {
  // Refusing matters more than cleaning: a path that needed cleaning is one
  // whose author meant something else, and a silently rewritten reference
  // points at a file that is no longer where the bundle says it is.
  const error = refusal(demo({ files: [file("index.html"), file("fallback.html"), file("../x.mjs")] }));
  assert.equal(error.code, "path_traversal");
  assert.equal(error.path, "../x.mjs");
});

test("a path that would not survive being a URL is refused", () => {
  for (const path of ["my file.js", "a%2e%2e/b.js", "q?x=1.js", "a#b.js", "file..", ".hidden.js"]) {
    assert.throws(() => normalizeBundlePath(path), InteractiveError, `"${path}" was accepted`);
  }
  assert.throws(() => normalizeBundlePath(`${"a/".repeat(LIMITS.pathDepth)}deep.js`), InteractiveError);
  assert.throws(() => normalizeBundlePath(`${"a".repeat(LIMITS.pathLength)}.js`), InteractiveError);
});

test("two files differing only in case are refused", () => {
  // They collide on a case-insensitive filesystem, so a bundle pushed from one
  // would arrive a file short and still look complete.
  const error = refusal(demo({
    files: [file("index.html"), file("fallback.html"), file("Demo.mjs"), file("demo.mjs")],
  }));
  assert.equal(error.code, "duplicate_file");
});

// ------------------------------------------------------- what may be shipped

test("a bundle cannot smuggle an extra HTML page", () => {
  // A lab's entry and either kind's fallback are documents on purpose. Any
  // other HTML would be a navigable page nothing in the design accounts for.
  const error = refusal(demo({
    files: [file("index.html"), file("fallback.html"), file("secret.html")],
  }));
  assert.equal(error.code, "unexpected_html");
  assert.equal(error.path, "secret.html");
});

test("a figure's entry is a module and a lab's is a page", () => {
  assert.equal(refusal(figure({ entry: "index.html", files: [file("index.html"), file("fallback.html")] })).code,
    "invalid_entry");
  assert.equal(refusal(demo({ entry: "demo.mjs" })).code, "invalid_entry");
});

test("a fallback is required, static, and not the entry itself", () => {
  assert.equal(refusal(demo({ fallback: undefined })).code, "invalid_path");
  assert.equal(refusal(demo({ fallback: "data.json" })).code, "invalid_fallback");
  assert.equal(refusal(demo({ fallback: "index.html" })).code, "invalid_fallback");
});

test("entry and fallback must be files the bundle actually declares", () => {
  assert.equal(refusal(demo({ entry: "missing.html" })).code, "undeclared_file");
  assert.equal(refusal(demo({ fallback: "missing.html" })).code, "undeclared_file");
});

test("file types a bundle may not contain are refused by name", () => {
  // SVG is a document that can carry script, and a figure's assets are served
  // from the post's own origin. Sanitizing one is its own project, exactly as
  // it is for attachments.
  for (const name of ["chart.svg", "page.xhtml", "old.htm", "doc.pdf", "mod.wasm", "run.sh", "noext"]) {
    assert.throws(() => bundleTypeFor(name), InteractiveError, `${name} was accepted`);
  }
  assert.equal(extensionOf("lib/plot/draw.mjs"), ".mjs");
});

test("a dependency is a name the engine vendors, never a URL", () => {
  assert.deepEqual(validateManifest(demo({ dependencies: ["distill"] })).dependencies, ["distill"]);
  for (const dependency of ["https://cdn.example.com/d3.js", "../d3.mjs", "left-pad", "Distill", "d3"]) {
    assert.equal(refusal(demo({ dependencies: [dependency] })).code, "invalid_dependency");
  }
});

test("every vendored name is something this engine actually serves", () => {
  // A dependency is a promise: the page has to be able to load it. §3.6 named
  // d3 as an example and the repository does not vendor it, so accepting the
  // name would publish a figure that resolves, builds, and then fails in the
  // reader's browser.
  const vendor = path.join(ROOT, "assets", "vendor");
  for (const name of VENDORED_DEPENDENCIES) {
    const source = VENDORED_SOURCES[name];
    assert.ok(source, `${name} is offered to bundles with no source`);
    assert.ok(source.startsWith("/assets/"), `${name} is served from off-site: ${source}`);
    assert.ok(
      fs.existsSync(path.join(vendor, path.basename(source))),
      `${name} is offered to bundles but ${source} is not in the repository`
    );
  }
});

// -------------------------------------------------------------- ownership

test("a bundle belonging to another post is a refusal, not a lookup miss", () => {
  const error = refusal(demo({ postId: "p_00000000000000bb" }), { postId: POST });
  assert.equal(error.code, "foreign_bundle");
});

test("a manifest that is not a bundle at all is refused", () => {
  assert.equal(refusal(null).code, "invalid_bundle");
  assert.equal(refusal(demo({ kind: "widget" })).code, "invalid_kind");
  assert.equal(refusal(demo({ files: [] })).code, "empty_bundle");
  assert.equal(refusal(demo({ files: [file("index.html"), file("fallback.html"), "not-an-object"] })).code,
    "invalid_file");
});

// ------------------------------------------------------------------- limits

test("a file must declare a size and a hash it can be checked against", () => {
  assert.equal(refusal(demo({ files: [file("index.html"), file("fallback.html"), file("x.mjs", { bytes: undefined })] })).code,
    "invalid_file");
  assert.equal(refusal(demo({ files: [file("index.html"), file("fallback.html"), file("x.mjs", { sha256: "abc" })] })).code,
    "invalid_file");
  assert.equal(refusal(demo({ files: [file("index.html"), file("fallback.html"), file("x.mjs", { bytes: -1 })] })).code,
    "invalid_file");
});

test("bounds hold per file, per bundle and per file count", () => {
  assert.equal(
    refusal(demo({ files: [file("index.html"), file("fallback.html"), file("big.json", { bytes: LIMITS.fileBytes + 1 })] })).code,
    "file_too_large"
  );

  const many = Array.from({ length: LIMITS.filesPerBundle + 1 }, (_, i) => file(`f${i}.json`));
  assert.equal(refusal(demo({ files: [file("index.html"), file("fallback.html"), ...many] })).code, "too_many_files");

  // Each file is inside its own limit; together they are not.
  const heavy = Array.from({ length: 4 }, (_, i) => file(`f${i}.json`, { bytes: LIMITS.fileBytes }));
  assert.equal(refusal(demo({ files: [file("index.html"), file("fallback.html"), ...heavy] })).code, "bundle_too_large");
});

// ------------------------------------------------- references and the fallback

import {
  resolveInteractiveReferences, readInteractivePayload, validateFallback,
  findInteractiveReferences,
} from "../lib/interactives.mjs";
import { renderInteractive } from "../lib/markdown.mjs";

const bundle = (over = {}) => ({
  id: "i_00000000000000b1", postId: POST, kind: "demo", name: "orbit",
  revisionId: "iv_00000000000000c1", entry: "index.html", fallback: "fallback.html",
  status: "verified", files: [file("index.html"), file("fallback.html")], ...over,
});

const resolveRefusal = (body, options) => {
  try {
    resolveInteractiveReferences(body, { slug: "a-post", postId: POST, ...options });
  } catch (err) {
    assert.ok(err instanceof InteractiveError, `threw a ${err.name}`);
    return err;
  }
  assert.fail("the reference was accepted");
};

test("a reference is found outside code and ignored inside it", () => {
  const body = "See ::demo[i_1] and ::figure[i_2].\n\n```\n::demo[i_3]\n```\n";
  assert.deepEqual(findInteractiveReferences(body, "markdown"), [
    { kind: "demo", id: "i_1" },
    { kind: "figure", id: "i_2" },
  ]);
  // LaTeX has no way to name an interactive at all (§4.2).
  assert.deepEqual(findInteractiveReferences(body, "latex"), []);
});

test("a bundle owned by another post is refused even when handed over directly", () => {
  // The store already scopes a listing to one post, so this is the second
  // lock: a caller that assembles the list itself cannot resolve a foreign
  // bundle by passing it in.
  const foreign = bundle({ postId: "p_00000000000000bb" });
  const error = resolveRefusal(`::demo[${foreign.id}]`, {
    interactives: [foreign], fallbacks: new Map([[foreign.id, "<p>x</p>"]]),
  });
  assert.equal(error.code, "unknown_interactive");
});

test("an unverified bundle cannot be referenced", () => {
  const pending = bundle({ status: "pending" });
  assert.equal(resolveRefusal(`::demo[${pending.id}]`, { interactives: [pending] }).code,
    "unknown_interactive");
});

test("a figure referenced as a lab is a wrong-kind refusal", () => {
  const figureBundle = bundle({ kind: "figure", entry: "main.mjs" });
  const error = resolveRefusal(`::demo[${figureBundle.id}]`, {
    interactives: [figureBundle], fallbacks: new Map([[figureBundle.id, "<p>x</p>"]]),
  });
  assert.equal(error.code, "wrong_kind");
});

test("a resolved payload survives a fallback containing backticks", () => {
  // The payload travels in a fenced block, so a fallback that contains three
  // backticks would otherwise end the fence and spill JSON into the article.
  const record = bundle();
  const { body } = resolveInteractiveReferences(`::demo[${record.id}]`, {
    slug: "a-post", postId: POST, interactives: [record],
    fallbacks: new Map([[record.id, "<p>Use ``` for code</p>"]]),
  });
  const fence = body.match(/```weblog-interactive\n([\s\S]*?)\n```/);
  assert.ok(fence, "the payload did not survive as a single fence");
  assert.ok(!fence[1].includes("```"), "a fence was left inside a fence");
  assert.ok(readInteractivePayload(fence[1]).fallback.includes("```"), "the fallback lost its text");
});

test("the renderer refuses a payload a resolver would not have written", () => {
  // A post may legitimately contain three backticks, so the renderer cannot
  // tell this fence from one an author typed. Every payload is re-checked.
  const hostile = [
    { kind: "demo", src: "https://evil.example/x.html", fallback: "" },
    { kind: "demo", src: "/demos/../../etc/passwd", fallback: "" },
    { kind: "demo", src: "/api/drafts/index.html", fallback: "" },
    { kind: "demo", src: "/demos/a/b/not-a-revision/index.html", fallback: "" },
    { kind: "figure", src: "/demos/a/b/iv_00000000000000c1/index.html", fallback: "" },
    { kind: "demo", src: "/demos/a/b/iv_00000000000000c1/index.html", fallback: "<script>x()</script>" },
  ];
  for (const payload of hostile) {
    assert.equal(readInteractivePayload(JSON.stringify(payload)), null, JSON.stringify(payload.src));
    assert.match(renderInteractive(JSON.stringify(payload)), /interactive--broken/, JSON.stringify(payload));
  }
  assert.equal(readInteractivePayload("not json at all"), null);

  const good = { kind: "demo", name: "orbit", src: "/demos/a-post/orbit/iv_00000000000000c1/index.html", fallback: "<p>ok</p>" };
  assert.ok(readInteractivePayload(JSON.stringify(good)), "a legitimate payload was refused");
  const html = renderInteractive(JSON.stringify(good));
  assert.ok(!/<iframe/i.test(html), "static HTML shipped an iframe");
  assert.match(html, /data-interactive-src="\/demos\/a-post\/orbit\/iv_00000000000000c1\/index\.html"/);
});

test("a figure payload is refused unless it names a module the engine published", () => {
  const good = {
    kind: "figure", name: "loss-surface", dependencies: ["distill"],
    src: "/assets/figures/a-post/loss-surface/iv_00000000000000c1/main.mjs",
    fallback: "<p>A still chart.</p>",
  };
  assert.ok(readInteractivePayload(JSON.stringify(good)), "a legitimate figure was refused");

  for (const bad of [
    // A figure is a module under the assets tree; a lab is a document under
    // the sandboxed one. Crossing them would grant the wrong privilege.
    { ...good, src: "/demos/a-post/orbit/iv_00000000000000c1/index.html" },
    { ...good, src: "/assets/figures/a-post/x/iv_00000000000000c1/index.html" },
    { ...good, src: "https://evil.example/main.mjs" },
    { ...good, src: "/assets/figures/a/x/not-a-revision/main.mjs" },
    // A dependency the engine does not serve. Refused here as well as at
    // publish, because this is the last check before it becomes a script tag.
    { ...good, dependencies: ["d3"] },
    { ...good, dependencies: ["https://cdn.example.com/d3.js"] },
  ]) {
    assert.equal(readInteractivePayload(JSON.stringify(bad)), null,
      `${bad.src} / ${bad.dependencies}`);
    assert.match(renderInteractive(JSON.stringify(bad)), /interactive--broken/);
  }
});

test("a figure's markup gives it a root of its own, and keeps the fallback", () => {
  const html = renderInteractive(JSON.stringify({
    kind: "figure", name: "loss-surface", dependencies: ["distill"],
    src: "/assets/figures/a-post/loss-surface/iv_00000000000000c1/main.mjs",
    fallback: "<p>A still chart.</p>",
  }));
  assert.match(html, /class="interactive interactive--figure"/);
  assert.match(html, /<div class="interactive-root" id="figure-loss-surface-iv_00000000000000c1">/);
  assert.match(html, /<div class="interactive-fallback"><p>A still chart\.<\/p><\/div>/);
  assert.match(html, /data-interactive-deps="distill"/);
  // A figure is page code, not a frame: the engine imports it, and nothing
  // about it is an iframe.
  assert.ok(!/<iframe/i.test(html));
});

test("a fallback is validated rather than cleaned", () => {
  assert.equal(validateFallback("<p>Plain <strong>text</strong>.</p>"), "<p>Plain <strong>text</strong>.</p>");

  for (const hostile of [
    "<script>steal()</script>",
    "<p onclick='steal()'>x</p>",
    "<p style='position:fixed'>x</p>",
    "<iframe src='/'></iframe>",
    "<a href='javascript:steal()'>x</a>",
    "<!-- <script>x</script> -->",
    "<form><input></form>",
    "<svg onload='steal()'></svg>",
  ]) {
    assert.throws(() => validateFallback(hostile), InteractiveError, hostile);
  }
});

test("a fallback that would swallow the article around it is refused", () => {
  // An unclosed tag does not break the fallback; it breaks every element that
  // comes after it on the page.
  assert.throws(() => validateFallback("<div><p>left open"), InteractiveError);
  assert.throws(() => validateFallback("<p>crossed</div>"), InteractiveError);
  assert.throws(() => validateFallback("</p>"), InteractiveError);
  // Void elements are not a missing close tag.
  assert.equal(validateFallback("<p>one<br>two</p>"), "<p>one<br />two</p>");
});

test("a fallback's image is pinned to a file the bundle declares", () => {
  const files = [file("fallback.html"), file("still.png")];
  assert.equal(
    validateFallback('<p><img src="./still.png" alt="a still"></p>', { files, publicPath: "/demos/a/b/iv_1/" }),
    '<p><img src="/demos/a/b/iv_1/still.png" alt="a still" /></p>'
  );
  assert.throws(
    () => validateFallback('<img src="./missing.png">', { files, publicPath: "/demos/a/b/iv_1/" }),
    InteractiveError
  );
  assert.throws(
    () => validateFallback('<img src="https://evil.example/pixel.png">', { files, publicPath: "/demos/a/b/iv_1/" }),
    InteractiveError
  );
});
