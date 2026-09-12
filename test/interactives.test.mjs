// Tier 2 and Tier 4 — the interactive bundle contract (CLAUDE.md §3.6).
//
// A bundle is the first thing this system will publish that the owner wrote as
// *code* rather than as prose, so the contract is the place where "what may be
// published" is decided. These tests weight towards refusals: a manifest that
// should not exist must be rejected here, before any byte is stored, because
// every later stage treats a validated manifest as trustworthy.
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateManifest, normalizeBundlePath, bundleTypeFor, computeRevisionId,
  sanitizeInteractiveName, publicBundlePath, publicFileUrl, extensionOf,
  InteractiveError, LIMITS, INTERACTIVE_REVISION_PATTERN, VENDORED_DEPENDENCIES,
} from "../lib/interactives.mjs";

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
  assert.deepEqual(validateManifest(demo({ dependencies: ["d3"] })).dependencies, ["d3"]);
  for (const dependency of ["https://cdn.example.com/d3.js", "../d3.mjs", "left-pad", "D3"]) {
    assert.equal(refusal(demo({ dependencies: [dependency] })).code, "invalid_dependency");
  }
  assert.ok(VENDORED_DEPENDENCIES.length > 0, "nothing is vendored, so no bundle can declare anything");
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
