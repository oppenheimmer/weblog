// Build-side media: published R2 objects -> dist/images/uploads/<slug>/<name>
// (CLAUDE.md §3.3, Step 6).
//
// §3.3 makes build cost a first-order concern, because every clean build
// re-downloads every published image and that grows without bound. So:
//
//   * bounded parallelism — not one at a time, not everything at once;
//   * a content-addressed cache outside dist/, keyed by SHA-256, which Vercel's
//     build cache carries between deploys (it keeps node_modules/);
//   * every object checked against the hash its revision recorded, and the
//     build stopped on a missing or mismatched file rather than shipping a
//     page whose image is broken.
//
// Revisions come from R2, so their media entries are treated as input to be
// validated, not as trusted paths: a tampered manifest must not be able to
// write outside dist/.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { keys } from "./keys.mjs";
import { normalizeBundlePath, publicBundlePath, INTERACTIVE_REVISION_PATTERN } from "../interactives.mjs";

export class MediaSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "MediaSyncError";
  }
}

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*\.(png|jpg|gif|webp)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** Every file a set of posts needs, with its source key and destination. */
export function mediaJobs(posts, distDir) {
  const root = path.resolve(distDir, "images", "uploads");
  const jobs = [];
  for (const post of posts) {
    for (const item of post.media ?? []) {
      if (!SAFE_SLUG.test(String(post.slug)) || !SAFE_NAME.test(String(item?.publicName)) ||
          !SHA256.test(String(item?.sha256)) || !post.postId) {
        throw new MediaSyncError(
          `Refusing an unsafe media entry for /${post.slug}/: ${JSON.stringify(item?.publicName)}.`
        );
      }
      const dest = path.resolve(root, post.slug, item.publicName);
      if (!dest.startsWith(root + path.sep)) {
        throw new MediaSyncError(`Media for /${post.slug}/ would be written outside the site.`);
      }
      jobs.push({
        key: keys.media(post.postId, item.publicName),
        dest,
        sha256: item.sha256,
        slug: post.slug,
        name: item.publicName,
      });
    }
  }
  return jobs;
}

/**
 * Every bundle file a set of posts needs, with its source key and destination.
 *
 * A revision's `interactives` come from R2 like everything else, so they are
 * input to be validated rather than paths to be trusted: a tampered manifest
 * must not be able to write outside dist/. The file names are re-checked
 * through the contract that accepted them, not merely pattern-matched here, so
 * there is one definition of a legal bundle path rather than two that can
 * drift apart.
 */
export function interactiveJobs(posts, distDir) {
  const root = path.resolve(distDir);
  const jobs = [];
  for (const post of posts) {
    for (const bundle of post.interactives ?? []) {
      const unsafe = (why) =>
        new MediaSyncError(`Refusing an unsafe interactive for /${post.slug}/: ${why}.`);
      if (!SAFE_SLUG.test(String(post.slug)) || !post.postId) throw unsafe("its post");
      if (!SAFE_SLUG.test(String(bundle?.name))) throw unsafe(JSON.stringify(bundle?.name));
      if (!INTERACTIVE_REVISION_PATTERN.test(String(bundle?.revisionId))) {
        throw unsafe(`revision ${JSON.stringify(bundle?.revisionId)}`);
      }
      if (bundle.kind !== "demo" && bundle.kind !== "figure") throw unsafe(`kind ${bundle.kind}`);

      const base = publicBundlePath(bundle.kind, post.slug, bundle.name, bundle.revisionId).slice(1);
      for (const file of bundle.files ?? []) {
        if (!SHA256.test(String(file?.sha256))) throw unsafe(`${file?.name} has no hash`);
        let name;
        try {
          name = normalizeBundlePath(file?.name);
        } catch (err) {
          throw unsafe(err.message);
        }
        const dest = path.resolve(root, base, name);
        if (!dest.startsWith(root + path.sep)) throw unsafe(`${name} would be written outside the site`);
        jobs.push({
          key: keys.publishedInteractive(post.postId, bundle.id, bundle.revisionId, name),
          dest,
          sha256: file.sha256,
          slug: post.slug,
          name: `${bundle.name}/${name}`,
        });
      }
    }
  }
  return jobs;
}

async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

/** Fetch, verify and place every published image. Returns counts for the build log. */
export async function syncPublishedMedia({ store, posts, distDir, cacheDir = null, concurrency = 6 }) {
  const started = Date.now();
  const bundles = interactiveJobs(posts, distDir);
  const jobs = [...mediaJobs(posts, distDir), ...bundles];
  const stats = {
    files: jobs.length, bundleFiles: bundles.length,
    downloaded: 0, cached: 0, bytes: 0, ms: 0,
  };

  await pool(jobs, concurrency, async (job) => {
    let body = null;
    const cached = cacheDir ? path.join(cacheDir, job.sha256) : null;

    if (cached && fs.existsSync(cached)) {
      const candidate = fs.readFileSync(cached);
      // A cache entry is only as good as its hash; a truncated one is refetched.
      if (sha256(candidate) === job.sha256) {
        body = candidate;
        stats.cached++;
      }
    }

    if (!body) {
      const object = await store.get(job.key);
      if (!object) {
        throw new MediaSyncError(
          `Published content for /${job.slug}/ is missing: ${job.name}. ` +
          `The build stopped rather than ship a broken page.`
        );
      }
      if (sha256(object.body) !== job.sha256) {
        throw new MediaSyncError(
          `Published content for /${job.slug}/ does not match its manifest: ${job.name}. ` +
          `The build stopped rather than ship the wrong bytes.`
        );
      }
      body = object.body;
      stats.downloaded++;
      if (cached) {
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(cached, body);
        } catch { /* a cold cache next time, never a failed build */ }
      }
    }

    fs.mkdirSync(path.dirname(job.dest), { recursive: true });
    fs.writeFileSync(job.dest, body);
    stats.bytes += body.length;
  });

  stats.ms = Date.now() - started;
  return stats;
}
