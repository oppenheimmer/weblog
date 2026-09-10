// Re-blesses the golden output set. Run deliberately, never automatically:
//
//   node test/helpers/bless.mjs
//
// A change under test/golden/ in a diff is the signal that public output moved.
// The commit that carries it must say why.
import fs from "node:fs";
import path from "node:path";
import { buildFixtures, manifestOf, cleanup, GOLDEN, GOLDEN_PAGES } from "./build-fixture.mjs";

const dist = buildFixtures();
try {
  const manifest = manifestOf(dist);
  fs.mkdirSync(path.join(GOLDEN, "pages"), { recursive: true });
  fs.writeFileSync(path.join(GOLDEN, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  for (const rel of GOLDEN_PAGES) {
    const src = path.join(dist, rel);
    if (!fs.existsSync(src)) throw new Error(`golden page missing from build: ${rel}`);
    const dest = path.join(GOLDEN, "pages", rel.replace(/\//g, "__"));
    fs.copyFileSync(src, dest);
  }

  console.log(`Blessed ${Object.keys(manifest).length} files, ${GOLDEN_PAGES.length} full pages.`);
} finally {
  cleanup(dist);
}
