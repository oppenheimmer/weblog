// Inspect what is in the bucket, and optionally sweep it.
//
//   node --env-file=.env scripts/inventory.mjs            # print the tree
//   node --env-file=.env scripts/inventory.mjs --gc       # what would be swept
//   node --env-file=.env scripts/inventory.mjs --gc --apply
import { createStore } from "../lib/server/r2.mjs";
import { buildInventory, collectGarbage, refreshInventory, formatTree } from "../lib/server/inventory.mjs";

const gc = process.argv.includes("--gc");
const apply = process.argv.includes("--apply");
const store = createStore();

const inventory = await buildInventory(store);
console.log(formatTree(inventory));

if (!gc) {
  await refreshInventory(store, {});
  console.log("\ninventory.json refreshed. Pass --gc to see what could be swept.");
  process.exit(0);
}

const swept = await collectGarbage(store, { apply, inventory });
console.log(`\n${apply ? "Swept" : "Would sweep"} ${swept.deletable} object(s), ` +
  `${(swept.bytesFreed / 1024).toFixed(1)} KB; kept ${swept.kept} reachable.`);
for (const key of swept.keys) console.log(`  ${apply ? "deleted" : "would delete"}  ${key}`);
if (swept.truncated) console.log("  … more remain; run again.");
if (!apply && swept.deletable) console.log("\nRe-run with --apply to delete.");
if (apply && swept.deleted) await refreshInventory(store, {});
