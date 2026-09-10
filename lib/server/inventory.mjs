// What exists, what still matters, and what may be deleted.
//
// A blog accumulates rubbish: every draft save writes an immutable revision,
// every republish supersedes one, deleted posts leave media behind. Without a
// sweep, R2 grows forever.
//
// The inventory is **derived, never maintained**. It is rebuilt from the
// authoritative records — the published index, draft pointers, and the objects
// actually in the bucket — rather than patched as things change. An
// incrementally-updated index would be a second source of truth, and would
// eventually disagree with reality in exactly the situation where being wrong
// is most expensive: deciding what to delete.
//
// Collection is mark-and-sweep, and deliberately timid. Anything it cannot
// prove is unreachable, it keeps.
import { INDEX_KEY, revisionKey as publishedRevisionKey } from "./publish.mjs";

export const INVENTORY_KEY = "inventory.json";

export const RETENTION = {
  // Superseded published revisions stay available to roll back to.
  publishedRevisionMs: 90 * 24 * 60 * 60 * 1000,
  // Draft history is a convenience, not a guarantee. Keep recent ones.
  draftRevisionMs: 30 * 24 * 60 * 60 * 1000,
  draftRevisionsPerPost: 20,
  // Uploads that were never attached to anything.
  pendingUploadMs: 24 * 60 * 60 * 1000,
  // Nothing newer than this is ever swept, whatever the graph says. An object
  // written seconds ago may belong to a workflow still in flight — an upload
  // mid-completion, a publish between its revision write and its index update.
  minAgeMs: 60 * 60 * 1000,
};

const parseKey = {
  draftRevision: (key) => key.match(/^drafts\/(p_[0-9a-f]+)\/revisions\/(r_[^/]+)\.json$/),
  draftPointer: (key) => key.match(/^drafts\/(p_[0-9a-f]+)\/current\.json$/),
  publishedRevision: (key) => key.match(/^published\/posts\/(p_[0-9a-f]+)\/(r_[^/]+)\.json$/),
  media: (key) => key.match(/^published\/media\/([^/]+)\/(.+)$/),
  upload: (key) => key.match(/^uploads\/([^/]+)\//),
};

/**
 * Build the tree: every post, its revisions, and the media each one references.
 *
 * Reads the bucket rather than trusting any stored summary, so the result
 * describes what is actually there.
 */
export async function buildInventory(store, { now = () => Date.now() } = {}) {
  const [indexRecord, objects] = await Promise.all([
    store.getJson(INDEX_KEY),
    store.listAll(""),
  ]);
  const index = indexRecord?.data ?? { posts: {} };

  const byKey = new Map(objects.map((o) => [o.key, o]));
  const posts = new Map();

  const post = (postId) => {
    if (!posts.has(postId)) {
      posts.set(postId, {
        postId, slug: null, title: null, state: "unknown",
        publishedRevisionId: null, draftRevisionId: null,
        revisions: [], media: [], bytes: 0,
      });
    }
    return posts.get(postId);
  };

  // Published: the index says which revision is current for each slug.
  for (const [slug, entry] of Object.entries(index.posts ?? {})) {
    const record = post(entry.postId);
    record.slug = slug;
    record.state = "published";
    record.publishedRevisionId = entry.revisionId;
  }

  // Draft pointers name the revision a post is currently being edited at.
  for (const { key } of objects) {
    const pointer = parseKey.draftPointer(key);
    if (!pointer) continue;
    const record = post(pointer[1]);
    const current = await store.getJson(key);
    if (!current) continue;
    record.draftRevisionId = current.data.revisionId;
    record.title ??= current.data.title || null;
    record.slug ??= current.data.slug || null;
    if (record.state === "unknown") record.state = "draft";
  }

  // Every revision object, published or draft.
  for (const object of objects) {
    const draft = parseKey.draftRevision(object.key);
    const published = parseKey.publishedRevision(object.key);
    if (!draft && !published) continue;

    const [, postId, revisionId] = draft ?? published;
    const record = post(postId);
    record.revisions.push({
      revisionId,
      kind: draft ? "draft" : "published",
      key: object.key,
      size: object.size ?? 0,
      lastModified: object.lastModified ?? null,
      current: revisionId === record.publishedRevisionId || revisionId === record.draftRevisionId,
    });
    record.bytes += object.size ?? 0;
  }

  // Media, attributed by the slug in its path.
  const slugToPost = new Map([...posts.values()].filter((p) => p.slug).map((p) => [p.slug, p.postId]));
  const orphanMedia = [];
  for (const object of objects) {
    const media = parseKey.media(object.key);
    if (!media) continue;
    const owner = slugToPost.get(media[1]);
    if (owner) {
      const record = post(owner);
      record.media.push({ key: object.key, name: media[2], size: object.size ?? 0 });
      record.bytes += object.size ?? 0;
    } else {
      orphanMedia.push({ key: object.key, slug: media[1], size: object.size ?? 0 });
    }
  }

  const uploads = objects
    .filter((o) => parseKey.upload(o.key))
    .map((o) => ({ key: o.key, size: o.size ?? 0, lastModified: o.lastModified ?? null }));

  for (const record of posts.values()) {
    record.revisions.sort((a, b) => a.revisionId.localeCompare(b.revisionId));
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    posts: [...posts.values()].sort((a, b) => String(a.slug).localeCompare(String(b.slug))),
    orphanMedia,
    pendingUploads: uploads,
    totals: {
      posts: posts.size,
      published: [...posts.values()].filter((p) => p.state === "published").length,
      objects: objects.length,
      bytes: objects.reduce((sum, o) => sum + (o.size ?? 0), 0),
    },
  };
}

/**
 * Which keys must survive.
 *
 * Everything reachable from a current published revision or a current draft,
 * plus history inside the retention windows. Deliberately generous: keeping
 * rubbish costs storage, deleting something reachable costs the post.
 */
export function reachableKeys(inventory, { now = Date.now(), retention = RETENTION } = {}) {
  const keep = new Set([INDEX_KEY, INVENTORY_KEY]);
  const age = (item) => (item.lastModified ? now - new Date(item.lastModified).getTime() : 0);

  for (const post of inventory.posts) {
    // Anything a post currently points at, always.
    if (post.publishedRevisionId) {
      keep.add(publishedRevisionKey(post.postId, post.publishedRevisionId));
    }
    if (post.draftRevisionId) {
      keep.add(`drafts/${post.postId}/revisions/${post.draftRevisionId}.json`);
      keep.add(`drafts/${post.postId}/current.json`);
    }
    // Media belonging to a post that still exists.
    for (const media of post.media) keep.add(media.key);

    // Superseded published revisions, for the rollback window.
    for (const revision of post.revisions) {
      if (revision.kind !== "published" || revision.current) continue;
      if (age(revision) < retention.publishedRevisionMs) keep.add(revision.key);
    }

    // Recent draft history, newest first, bounded by both count and age.
    const draftHistory = post.revisions
      .filter((r) => r.kind === "draft" && !r.current)
      .sort((a, b) => b.revisionId.localeCompare(a.revisionId));
    draftHistory.slice(0, retention.draftRevisionsPerPost).forEach((revision) => {
      if (age(revision) < retention.draftRevisionMs) keep.add(revision.key);
    });
  }

  for (const upload of inventory.pendingUploads) {
    if (age(upload) < retention.pendingUploadMs) keep.add(upload.key);
  }

  return keep;
}

/**
 * Delete what is provably unreachable.
 *
 * Dry by default. Every caller that wants deletion says so explicitly, because
 * the failure mode here is losing a post rather than wasting a byte.
 */
export async function collectGarbage(store, {
  apply = false,
  now = () => Date.now(),
  retention = RETENTION,
  maxDeletions = 500,
  inventory,
} = {}) {
  const tree = inventory ?? await buildInventory(store, { now });
  const timestamp = now();
  const keep = reachableKeys(tree, { now: timestamp, retention });

  const objects = await store.listAll("");
  const candidates = [];
  for (const object of objects) {
    if (keep.has(object.key)) continue;
    // Sessions and rate limits expire on their own schedule; not this sweep's
    // business, and deleting a live session would sign the owner out.
    if (/^(sessions|rate-limits)\//.test(object.key)) continue;
    // Never touch anything recent, whatever the graph says.
    const created = object.lastModified ? new Date(object.lastModified).getTime() : timestamp;
    if (timestamp - created < retention.minAgeMs) continue;
    candidates.push(object);
  }

  const doomed = candidates.slice(0, maxDeletions);
  let deleted = 0;
  if (apply) {
    for (const object of doomed) {
      await store.delete(object.key);
      deleted++;
    }
  }

  return {
    apply,
    scanned: objects.length,
    kept: keep.size,
    deletable: candidates.length,
    deleted,
    truncated: candidates.length > doomed.length,
    bytesFreed: doomed.reduce((sum, o) => sum + (o.size ?? 0), 0),
    keys: doomed.map((o) => o.key),
  };
}

/** Rebuild the inventory file. Cheap enough to run on every state change. */
export async function refreshInventory(store, options = {}) {
  const tree = await buildInventory(store, options);
  await store.putJson(INVENTORY_KEY, tree);
  return tree;
}

/**
 * Called after anything that changes what exists.
 *
 * Never throws: a publish that succeeded must not be reported as failed because
 * housekeeping afterwards did not.
 */
export async function onStateChange(store, { apply = true, ...options } = {}) {
  try {
    const inventory = await refreshInventory(store, options);
    const swept = await collectGarbage(store, { ...options, apply, inventory });
    // The sweep changes what exists, so the file is rewritten to match.
    if (swept.deleted > 0) await refreshInventory(store, options);
    return { ok: true, inventory, swept };
  } catch (err) {
    console.error(`inventory refresh failed: ${err?.message}`);
    return { ok: false, error: err?.message };
  }
}

/** Human-readable tree, for the CLI and for eyeballing what is in the bucket. */
export function formatTree(inventory) {
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
  const lines = [
    `weblog inventory — ${inventory.totals.posts} post(s), ` +
    `${inventory.totals.published} published, ${inventory.totals.objects} objects, ` +
    `${kb(inventory.totals.bytes)}`,
    "",
  ];

  for (const post of inventory.posts) {
    lines.push(`${post.slug ?? "(no slug)"}  [${post.state}]  ${post.postId}  ${kb(post.bytes)}`);
    if (post.title) lines.push(`  title: ${post.title}`);

    const published = post.revisions.filter((r) => r.kind === "published");
    const drafts = post.revisions.filter((r) => r.kind === "draft");

    if (published.length) {
      lines.push(`  published revisions (${published.length}):`);
      for (const r of published) lines.push(`    ${r.current ? "*" : " "} ${r.revisionId}`);
    }
    if (drafts.length) {
      lines.push(`  draft revisions (${drafts.length}):`);
      for (const r of drafts.slice(-5)) lines.push(`    ${r.current ? "*" : " "} ${r.revisionId}`);
      if (drafts.length > 5) lines.push(`      … ${drafts.length - 5} older`);
    }
    if (post.media.length) {
      lines.push(`  media (${post.media.length}):`);
      for (const m of post.media) lines.push(`    ${m.name}  ${kb(m.size)}`);
    }
    lines.push("");
  }

  if (inventory.orphanMedia.length) {
    lines.push(`orphaned media (${inventory.orphanMedia.length}) — no post owns these:`);
    for (const m of inventory.orphanMedia) lines.push(`  ${m.key}  ${kb(m.size)}`);
    lines.push("");
  }
  if (inventory.pendingUploads.length) {
    lines.push(`pending uploads (${inventory.pendingUploads.length}) — not yet attached:`);
    for (const u of inventory.pendingUploads) lines.push(`  ${u.key}  ${kb(u.size)}`);
    lines.push("");
  }
  lines.push("* = current");
  return lines.join("\n");
}
