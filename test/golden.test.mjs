// Tier 0 — golden output.
//
// The cheapest, broadest regression net there is: build the fixture corpus and
// compare every emitted file against a recorded manifest. A failing hash names
// exactly which page moved; the stored full pages show how.
//
// To accept an intended change: node test/helpers/bless.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildFixtures, manifestOf, cleanup, readGoldenManifest, GOLDEN, GOLDEN_PAGES,
} from "./helpers/build-fixture.mjs";

test("Tier 0: emitted file set matches the golden manifest", () => {
  const dist = buildFixtures();
  try {
    const actual = manifestOf(dist);
    const golden = readGoldenManifest();

    const added = Object.keys(actual).filter((k) => !(k in golden));
    const removed = Object.keys(golden).filter((k) => !(k in actual));
    assert.deepEqual(added, [], `unexpected new files in dist:\n  ${added.join("\n  ")}`);
    assert.deepEqual(removed, [], `files vanished from dist:\n  ${removed.join("\n  ")}`);

    const changed = Object.keys(golden).filter((k) => golden[k] !== actual[k]);
    assert.deepEqual(
      changed, [],
      `content changed in:\n  ${changed.join("\n  ")}\n` +
      `If deliberate, re-bless with: node test/helpers/bless.mjs`
    );
  } finally {
    cleanup(dist);
  }
});

test("Tier 0: representative pages match byte for byte", () => {
  const dist = buildFixtures();
  try {
    for (const rel of GOLDEN_PAGES) {
      const actual = fs.readFileSync(path.join(dist, rel), "utf8");
      const expected = fs.readFileSync(path.join(GOLDEN, "pages", rel.replace(/\//g, "__")), "utf8");
      assert.equal(actual, expected, `${rel} differs from its golden copy`);
    }
  } finally {
    cleanup(dist);
  }
});

test("Tier 7: the build is deterministic across runs", () => {
  const a = buildFixtures();
  const b = buildFixtures();
  try {
    assert.deepEqual(manifestOf(a), manifestOf(b), "two builds of identical input differ");
  } finally {
    cleanup(a);
    cleanup(b);
  }
});
