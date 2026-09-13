// The staging push (CLAUDE.md §3.6, Slice 6E).
//
//   node --env-file=.env scripts/push.mjs staging/<post>            # what it would do
//   node --env-file=.env scripts/push.mjs staging/<post> --apply    # do it
//
// Options:
//   --apply           push, publish, confirm against R2, and delete what was confirmed
//   --replace-draft   replace a draft that has changes not yet published
//   --post <postId>   the post to push to, when several drafts share the address
//
// Sends a staged post folder — one .md, .markdown or .tex source and the
// interactive folders it names — through the same draft, upload and publish
// services as the editor, then removes it from disk. Nothing is deleted before
// the post is published, and only files R2 is read back to hold. The target is
// R2_PREFIX: `prod` is the live site.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { loadR2Config, describe } from "../lib/server/config.mjs";
import { readStagedPost, createStagingPush, StagingError } from "../lib/server/staging.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--post");

const apply = flag("--apply");
const replaceDraft = flag("--replace-draft");
const postId = option("--post");

if (positional.length !== 1 || flag("--help")) {
  console.log("Usage: node --env-file=.env scripts/push.mjs <staged post folder> [--apply] [--replace-draft] [--post <postId>]");
  process.exit(positional.length === 1 ? 0 : 1);
}

const fail = (message) => {
  console.error(`\nRefused: ${message}`);
  console.error("Nothing was written to R2 and nothing was removed from staging.");
  process.exit(1);
};

const dir = path.resolve(positional[0]);
// The engine itself is never a staged post. Accounting would refuse it anyway;
// refusing by name says why before walking node_modules.
if (dir === ROOT || ROOT.startsWith(`${dir}${path.sep}`)) {
  fail(`${positional[0]} is the engine, or contains it. Stage a post in a folder of its own.`);
}

let staged;
try {
  staged = readStagedPost(dir);
} catch (err) {
  if (err instanceof StagingError) fail(err.message);
  throw err;
}

const config = loadR2Config();
const where = describe(config);
console.log(`Staging push — bucket ${where.bucket}, prefix "${where.prefix}" — ${apply ? "APPLYING" : "dry run"}\n`);

if (apply && process.env.PUBLISH_ENABLED === "false") {
  fail("PUBLISH_ENABLED is false in this environment.");
}

const store = createStore({ config });
const pusher = createStagingPush(store);
const rel = (file) => path.relative(process.cwd(), file) || ".";
const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

let plan;
try {
  plan = await pusher.plan(staged, { postId, replaceDraft });
} catch (err) {
  if (err instanceof StagingError) fail(err.message);
  throw err;
}

if (plan.empty) {
  console.log(`${rel(dir)} holds only empty folders: nothing to push.`);
  if (!apply) process.exit(0);
  const result = await pusher.push(staged);
  console.log(`Removed ${result.removedDirs.length} empty folder(s).`);
  process.exit(0);
}

const DRAFT = {
  create: "create a new post",
  branch: "branch a draft from the published revision",
  save: "save over a draft with nothing unpublished",
  unchanged: "unchanged",
  replace: "REPLACE a draft that has unpublished changes",
};
const BUNDLE = {
  upload: (b) => `upload ${b.files} file(s), ${kb(b.bytes)}`,
  stored: () => "already stored; nothing to transfer",
  promote: (b) => `an earlier revision already stored; put ${b.revisionId} back`,
  reuse: (b) => `not staged; use the post's ${b.name}`,
  finish: () => "remainder of an earlier push; confirm and remove",
};

console.log(`Source   ${staged.source.name} (${staged.source.format}) → /${plan.slug}/`);
console.log(`Post     ${plan.postId ?? "new"}${plan.live ? `, on the site as ${plan.live}` : ""}`);
console.log(`Draft    ${DRAFT[plan.draft]}`);
for (const bundle of plan.bundles) {
  console.log(`${bundle.kind.padEnd(8)} ${bundle.folder}/ — ${BUNDLE[bundle.action](bundle)}`);
}
for (const removal of plan.removals ?? []) {
  console.log(`${"remove".padEnd(8)} ${removal.kind === "demo" ? "lab" : "figure"} ${removal.name} — the source no longer names it`);
}
console.log("Publish  then confirm every staged file against R2 and remove it\n");

if (!apply) {
  console.log("Dry run. Re-run with --apply to push, publish and clear the staged folder.");
  process.exit(0);
}

let result;
try {
  result = await pusher.push(staged, { postId, replaceDraft, log: (line) => console.log(line) });
} catch (err) {
  console.error(`\nThe push stopped: ${err.message}`);
  console.error("Nothing was removed from staging. Fix the cause and run the push again; it resumes.");
  process.exit(1);
}

console.log(`\nPublished ${result.postId} at /${result.slug}/ as ${result.revisionId}.`);
console.log(`Removed ${result.removed.length} staged file(s) and ${result.removedDirs.length} folder(s).`);
if (result.removedInteractives.length) {
  console.log(`Removed ${result.removedInteractives.length} interactive(s) the source no longer names.`);
}
if (result.kept.length) {
  console.log(`\nKept ${result.kept.length} file(s), each unconfirmed:`);
  for (const { path: file, reason } of result.kept) console.log(`  ${rel(file)} — ${reason}`);
  console.log("\nRun the push again to send what changed or finish what was left.");
  process.exit(1);
}
console.log("Staging holds nothing of this post.");
