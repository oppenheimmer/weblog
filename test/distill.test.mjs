// Tier 4 — the Distill template on public pages (CLAUDE.md §3.6).
//
// Its components inject <style> elements, which public pages refuse, so the
// twelve blocks the vendored template injects are allowed by hash and nothing
// else is. What a browser does with that is measured by
// scripts/verify-public-csp.mjs; this pins the configuration it measures, and
// the one change made to the upstream template: KaTeX from this site.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { DISTILL_STYLE_HASHES, distillStyleSources } from "../lib/distill.mjs";
import { KATEX_ASSET_ROOT } from "../lib/katex-assets.mjs";
import { editorCsp } from "../lib/server/pages.mjs";
import { headersFor, readRouting } from "../lib/routing.mjs";
import { ROOT, buildFixtures, cleanup } from "./helpers/build-fixture.mjs";

const routing = () => readRouting(JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")));
const directive = (policy, name) =>
  policy.split(";").map((part) => part.trim()).find((part) => part.split(/\s+/)[0] === name) ?? "";

test("public pages allow exactly the Distill template's style blocks, and no other inline style", () => {
  const style = directive(headersFor(routing(), "/a-post/").get("content-security-policy"), "style-src");
  const hashes = (style.match(/'sha256-[^']+'/g) ?? []).map((source) => source.slice(1, -1));
  assert.deepEqual([...hashes].sort(), [...DISTILL_STYLE_HASHES].sort(), "vercel.json and lib/distill.mjs disagree");
  assert.ok(!style.includes("'unsafe-inline'"), "every inline style element was allowed, not just Distill's");
  assert.deepEqual(style.split(/\s+/).filter((token) => !token.startsWith("'sha256-")),
    ["style-src", "'self'", "https://fonts.googleapis.com"], "the public style sources changed");
});

test("Run preview allows the same blocks, and sign-in allows none", () => {
  const preview = directive(editorCsp({ preview: true }), "style-src");
  assert.ok(preview.includes(distillStyleSources()), "a Distill figure would render differently in Run preview");
  assert.ok(!preview.includes("'unsafe-inline'"));
  assert.ok(!editorCsp({}).includes("sha256-"), "the sign-in page allows Distill's styles");
});

test("the hashes are twelve distinct SHA-256 digests", () => {
  assert.equal(new Set(DISTILL_STYLE_HASHES).size, 12);
  for (const hash of DISTILL_STYLE_HASHES) assert.match(hash, /^sha256-[A-Za-z0-9+/]{43}=$/);
});

test("both figure loaders stop Distill typesetting $$ text in the page", () => {
  // Measured in scripts/verify-public-csp.mjs; this pins that Run preview's
  // loader does what the published one does.
  for (const file of ["blog.js", "preview-run.js"]) {
    const script = fs.readFileSync(path.join(ROOT, "assets", file), "utf8");
    assert.match(script, /tag\.onload = function \(\) \{[^}]*if \(name === "distill" && window\.DMath\) window\.DMath\.katexOptions = \{\};\s*resolve\(\);/,
      `${file} leaves Distill scanning the page for $$`);
  }
  const template = fs.readFileSync(path.join(ROOT, "assets", "vendor", "distill.template.v2.js"), "utf8");
  // What the loaders rely on: without delimiters, neither the setter nor the
  // loaded callback scans the document.
  assert.match(template, /static set katexOptions\(options\) \{\s*DMath\._katexOptions = options;\s*if \(DMath\.katexOptions\.delimiters\)/);
  assert.match(template, /if \(DMath\.katexOptions\.delimiters\) \{\s*renderMathInElement\(document\.body, DMath\.katexOptions\);/);
});

test("the vendored Distill template loads KaTeX from this site, and the build ships it", () => {
  const template = fs.readFileSync(path.join(ROOT, "assets", "vendor", "distill.template.v2.js"), "utf8");
  assert.ok(!template.includes("distill.pub/third-party/katex"), "the template still loads KaTeX from distill.pub");
  assert.match(template, /const katexJSURL = '\/assets\/vendor\/katex\.min\.js';/);
  assert.match(template, /document\.querySelector\('meta\[name="weblog-katex-css"\]'\)/);

  const dist = buildFixtures();
  try {
    assert.deepEqual(fs.readFileSync(path.join(dist, "assets", "vendor", "katex.min.js")),
      fs.readFileSync(path.join(ROOT, "node_modules", "katex", "dist", "katex.min.js")));
    assert.ok(fs.existsSync(path.join(dist, KATEX_ASSET_ROOT.slice(1), "katex.min.css")));
    assert.ok(
      fs.readFileSync(path.join(dist, "embeds", "index.html"), "utf8")
        .includes(`<meta name="weblog-katex-css" content="${KATEX_ASSET_ROOT}/katex.min.css" />`),
      "a Distill page without body math does not expose the stylesheet for dynamic <d-math>"
    );
  } finally {
    cleanup(dist);
  }
});
