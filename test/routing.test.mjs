// The model of vercel.json that two security checks read from (CLAUDE.md §3.6).
//
// `lib/routing.mjs` exists so the tripwires below and
// `scripts/verify-demo-sandbox.mjs` cannot disagree about what the deployed
// configuration says. That makes its failure mode worth testing directly: a
// matcher that quietly matched nothing would turn "this security header is
// missing" into a passing test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { readRouting, headersFor, fileFor, compileSource, RoutingError } from "../lib/routing.mjs";
import { ROOT } from "./helpers/build-fixture.mjs";

const routing = () =>
  readRouting(JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")));

test("the project's own configuration is expressible", () => {
  // If this fails, a rule was added in syntax the model cannot represent, and
  // every assertion made through it is now worth less than it looks.
  assert.doesNotThrow(routing);
});

test("a pattern the model cannot represent is refused, never silently unmatched", () => {
  assert.throws(() => compileSource("/blog/:slug/comments"), RoutingError);
  assert.throws(() => compileSource("/(post|page)/(.*)"), RoutingError);
  assert.throws(() => compileSource("relative/path"), RoutingError);
});

test("a wildcard matches a whole subtree and nothing above it", () => {
  const match = compileSource("/demos/(.*)");
  assert.ok(match.test("/demos/a/b/c/index.html"));
  assert.ok(match.test("/demos/"));
  assert.ok(!match.test("/demos"));
  assert.ok(!match.test("/xdemos/a"));
  // A literal dot is a dot, not "any character": /images.uploads/ is a
  // different path and must not inherit the uploads rule.
  assert.ok(!compileSource("/styles/katex.min.css").test("/styles/katexxmin.css"));
});

test("a later rule wins on a repeated key, the way the platform resolves them", () => {
  const config = {
    headers: [
      { source: "/demos/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/demos/(.*)", headers: [{ key: "cache-control", value: "immutable" }] },
    ],
  };
  assert.equal(headersFor(readRouting(config), "/demos/x").get("cache-control"), "immutable");
});

test("a directory URL serves the index beside a bundle's own files", () => {
  // Load-bearing for §3.6: a bundle keeps its filenames and uses relative
  // paths, so the entry has to be served *at* the directory URL. Served one
  // level up, every `./demo.mjs` in every bundle resolves to the wrong place.
  const config = routing();
  assert.equal(fileFor(config, "/demos/a-post/lab/rev1/"), "demos/a-post/lab/rev1/index.html");
  assert.equal(fileFor(config, "/demos/a-post/lab/rev1/demo.mjs"), "demos/a-post/lab/rev1/demo.mjs");
  // cleanUrls: an extensionless path is the .html file it stands for.
  assert.equal(fileFor(config, "/demos/a-post/lab/rev1/fallback"), "demos/a-post/lab/rev1/fallback.html");
  assert.equal(fileFor(config, "/demos/../../etc/passwd"), null);
});
