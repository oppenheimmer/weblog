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
  for (const [name, parent, floor] of [["linkify-it", "markdown-it", "5.0.2"], ["js-yaml", "gray-matter", "3.15.2"]]) {
    const version = installed(name, parent);
    assert.ok(atLeast(version, floor), `${name} ${version} is below ${floor}, which fixes a quadratic parse`);
  }
});
