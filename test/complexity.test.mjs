// Tier 4 — algorithmic-complexity regressions (CLAUDE.md Appendix C, F-03).
//
// Two parsers on every post's path had quadratic cases reachable from post
// text: linkify-it's mailto: scan (GHSA-v245-v573-v5vm) and several js-yaml 3.x
// merge and omap paths. Measured here before the fix, 224 KB of repeated
// "mailto:" took 1.9 s to render: four times the input, fifteen times the time.
// These guard the fixed versions without betting on a fast machine.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { mdBrowser } from "../lib/markdown.mjs";
import { ROOT } from "./helpers/build-fixture.mjs";

const renderMs = (kb) => {
  const text = "mailto:".repeat(Math.floor((kb * 1024) / 7));
  const started = process.hrtime.bigint();
  mdBrowser.render(text);
  return Number(process.hrtime.bigint() - started) / 1e6;
};

test("rendering repeated mailto: text grows linearly, not quadratically", () => {
  renderMs(8); // warm the renderer
  const small = Math.min(renderMs(56), renderMs(56));
  const large = Math.min(renderMs(224), renderMs(224));
  // Four times the input is about 4x the time when linear and about 16x when
  // quadratic. The absolute floor keeps a slow machine from failing a fast parser.
  assert.ok(large < 250 || large / Math.max(small, 1) < 8,
    `224 KB took ${large.toFixed(0)} ms against ${small.toFixed(0)} ms for 56 KB`);
});

test("the parsers on the post path are at or above their fixed versions", () => {
  // js-yaml's quadratic cases could not be reproduced through gray-matter here,
  // so the floor itself is what is pinned: a lockfile regression fails loudly.
  const installed = (name, parent) => {
    const nested = path.join(ROOT, "node_modules", parent, "node_modules", name, "package.json");
    const hoisted = path.join(ROOT, "node_modules", name, "package.json");
    return JSON.parse(fs.readFileSync(fs.existsSync(nested) ? nested : hoisted, "utf8")).version;
  };
  const atLeast = (version, floor) => {
    const [a, b] = [version, floor].map((v) => v.split(".").map(Number));
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
  };
  for (const [name, parent, floor] of [
    ["linkify-it", "markdown-it", "5.0.2"],
    ["markdown-it", "", "14.3.1"],
    ["js-yaml", "gray-matter", "3.15.2"],
  ]) {
    const version = installed(name, parent);
    assert.ok(atLeast(version, floor), `${name} ${version} is below ${floor}, which fixes a quadratic parse`);
  }
});

test("js-yaml's CLI works with the argparse 2 override", () => {
  // argparse 1 pulls in unpatched sprintf-js (GHSA-hp3w-g68c-fv3c).
  // Keep js-yaml 3's safeLoad API for gray-matter and use argparse 2's legacy
  // aliases for its CLI. Exercise that compatibility across the major override.
  const require = createRequire(import.meta.url);
  const matterRequire = createRequire(require.resolve("gray-matter"));
  const cli = matterRequire.resolve("js-yaml/bin/js-yaml.js");
  for (const [input, expected] of [
    ["title: Audit\ntags: [a, b]\n", '{\n  "title": "Audit",\n  "tags": [\n    "a",\n    "b"\n  ]\n}\n'],
    ['{"title":"Audit"}', "title: Audit\n\n"],
  ]) {
    const result = spawnSync(process.execPath, [cli], { input, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 5000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: js-yaml/);
});
