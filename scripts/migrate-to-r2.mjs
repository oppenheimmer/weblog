// One-time migration: content/posts/ -> R2 (CLAUDE.md §1.1, Step 6).
//
//   node --env-file=.env scripts/migrate-to-r2.mjs           # dry run
//   node --env-file=.env scripts/migrate-to-r2.mjs --apply
//
// After this the repository is the engine and R2 holds the data, which is the
// governing principle. Slugs are preserved exactly, so no public URL moves.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { createPublisher } from "../lib/server/publish.mjs";
import { parseSource, formatFromFilename, derivePostSlug } from "../lib/content.mjs";
import { newPostId, newRevisionId } from "../lib/server/drafts.mjs";
import { loadR2Config } from "../lib/server/config.mjs";

const apply = process.argv.includes("--apply");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POSTS = path.join(ROOT, "content", "posts");

const config = loadR2Config();
const store = createStore({ config });
// The migration must not trigger a build per post; one rebuild at the end.
const publisher = createPublisher(store, { fireDeployHook: async () => ({ deferred: true }) });

const iso = (value) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString().slice(0, 10);
};

console.log(`Bucket ${config.bucket}, prefix "${config.prefix}" — ${apply ? "APPLYING" : "dry run"}\n`);

const files = fs.existsSync(POSTS)
  ? fs.readdirSync(POSTS).filter((f) => f.endsWith(".md") || f.endsWith(".tex")).sort()
  : [];
if (!files.length) {
  console.log("Nothing in content/posts/ to migrate.");
  process.exit(0);
}

const { data: index } = await publisher.readIndex();
let migrated = 0;

for (const file of files) {
  const raw = fs.readFileSync(path.join(POSTS, file), "utf8");
  const { data, body } = parseSource(raw);

  if (data.draft === true) { console.log(`  skip (draft)      ${file}`); continue; }

  const slug = derivePostSlug({ filename: file, frontmatterSlug: data.slug });
  if (index.posts?.[slug]) { console.log(`  skip (published)  ${file} -> /${slug}/`); continue; }

  const record = {
    postId: newPostId(),
    revisionId: newRevisionId(1),
    version: 1,
    title: data.title,
    date: iso(data.date),
    description: data.description ?? "",
    tags: Array.isArray(data.tags) ? data.tags : [],
    format: formatFromFilename(file),
    slug,
    body,
    ...(data.math === undefined ? {} : { math: data.math === true }),
  };

  if (!apply) {
    console.log(`  would migrate     ${file} -> /${slug}/  (${record.format}, ${record.date})`);
    continue;
  }

  const job = await publisher.publish(record);
  console.log(`  migrated          ${file} -> /${slug}/  [${job.state}]`);
  migrated++;
}

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write to R2.");
  process.exit(0);
}

console.log(`\nMigrated ${migrated} post(s).`);
if (migrated) {
  const { defaultDeployHook } = await import("../lib/server/publish.mjs");
  const hook = await defaultDeployHook().catch((err) => ({ error: err.message }));
  console.log("Rebuild triggered:", JSON.stringify(hook));
}
console.log("\nNext: delete content/posts/ so the repository holds no data (§1.1).");
