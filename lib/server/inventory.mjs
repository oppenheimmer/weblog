// What exists, what still matters, and what may be deleted.
//
// A blog accumulates rubbish: every draft save writes an immutable revision,
// every republish supersedes one, deleted posts leave media behind. Without a
// sweep, R2 grows forever.
//
// Collection is **ownership-scoped**, not reachability-scoped. Every object
// carries its owning post's id in its key (see keys.mjs), so deciding what to
// delete never requires reasoning about the whole bucket at once:
//
//   * deleting a post means deleting exactly its prefixes;
//   * an object whose owner is not a live post is a stray;
//   * within a live post, retention decides which old revisions to keep.
//
// The point is the blast radius. A global mark-and-sweep that misses one edge
// deletes across every post. Here a mistake can only damage the post already
// being worked on, and objects belonging to other posts are unreachable by
// construction rather than by care.
//
// The tree itself is **derived, never maintained** — rebuilt from the published
// index, draft pointers and the objects actually present. An incrementally
// patched index becomes a second source of truth and eventually disagrees with
// reality, which matters most in exactly the moment it is used to justify a
// deletion.
import { INDEX_KEY } from "./publish.mjs";
import { keys, classifyKey, ownedPrefixes } from "./keys.mjs";

export const INVENTORY_KEY = keys.inventory;

export const RETENTION = {
  // Superseded published revisions stay available to roll back to.
  publishedRevisionMs: 90 * 24 * 60 * 60 * 1000,
  // Draft history is a convenience, not a guarantee.
  draftRevisionMs: 30 * 24 * 60 * 60 * 1000,
  draftRevisionsPerPost: 20,
  // Uploads that were never attached to anything.
  pendingUploadMs: 24 * 60 * 60 * 1000,
  // Nothing newer than this is swept, whatever the rules say. An object written
  // seconds ago may belong to a workflow still in flight — an upload
  // mid-completion, a publish between its revision write and its index update.
  minAgeMs: 60 * 60 * 1000,
};

/**
 * Build the tree: every post, its revisions, and the media each one owns.
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

  const posts = new Map();
  const post = (postId) => {
    if (!posts.has(postId)) {
      posts.set(postId, {
        postId, slug: null, title: null, state: "orphan",
        publishedRevisionId: null, draftRevisionId: null,
        revisions: [], media: [], uploads: [], attachments: [], interactives: [], bytes: 0,
      });
    }
    return posts.get(postId);
  };

  // A post is live if the published index names it, or a draft pointer exists.
  for (const [slug, entry] of Object.entries(index.posts ?? {})) {
    const record = post(entry.postId);
    record.slug = slug;
    record.state = "published";
    record.publishedRevisionId = entry.revisionId;
  }

  const unknownKeys = [];

  for (const object of objects) {
    const info = classifyKey(object.key);

    if (info.kind === "unknown") { unknownKeys.push(object.key); continue; }
    if (!info.owned) continue;

    const record = post(info.postId);
    record.bytes += object.size ?? 0;
    const common = { key: object.key, size: object.size ?? 0, lastModified: object.lastModified ?? null };

    switch (info.kind) {
      case "draft-pointer": {
        const current = await store.getJson(object.key);
        if (!current) break;
        record.draftRevisionId = current.data.revisionId;
        record.title ??= current.data.title || null;
        record.slug ??= current.data.slug || null;
        if (record.state === "orphan") record.state = "draft";
        break;
      }
      case "draft-revision":
        record.revisions.push({ ...common, revisionId: info.id, kind: "draft" });
        break;
      case "published-revision":
        record.revisions.push({ ...common, revisionId: info.id, kind: "published" });
        break;
      case "media":
        record.media.push({ ...common, name: info.name });
        break;
      case "upload":
        record.uploads.push({ ...common, name: info.name });
        break;
      case "attachment-record":
      case "attachment-blob":
      case "attachment-name":
        record.attachments.push({ ...common, name: info.name, kind: info.kind });
        break;
      case "interactive-name":
      case "interactive-manifest":
      case "interactive-file":
      case "published-interactive":
        record.interactives.push({
          ...common,
          kind: info.kind,
          interactiveId: info.id,
          revisionId: info.revisionId,
          name: info.name,
        });
        break;
    }
  }

  for (const record of posts.values()) {
    record.revisions.sort((a, b) => a.revisionId.localeCompare(b.revisionId));
    for (const revision of record.revisions) {
      revision.current =
        revision.revisionId === record.publishedRevisionId ||
        revision.revisionId === record.draftRevisionId;
    }
  }

  const all = [...posts.values()].sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return {
    schemaVersion: 2,
    generatedAt: new Date(now()).toISOString(),
    posts: all,
    // Owners with no published entry and no draft pointer: nothing references
    // them any more, so the whole prefix is collectable.
    orphanPostIds: all.filter((p) => p.state === "orphan").map((p) => p.postId),
    // Keys matching no convention. Reported, never deleted — far likelier to
    // mean keys.mjs is out of date than that the object is rubbish.
    unknownKeys,
    totals: {
      posts: all.length,
      published: all.filter((p) => p.state === "published").length,
      drafts: all.filter((p) => p.state === "draft").length,
      orphans: all.filter((p) => p.state === "orphan").length,
      objects: objects.length,
      bytes: objects.reduce((sum, o) => sum + (o.size ?? 0), 0),
    },
  };
}

/**
 * Which of a single post's objects may go.
 *
 * Scoped to one post by construction: it is handed that post's record and can
 * name no other post's keys.
 */
export function collectableForPost(record, { now = Date.now(), retention = RETENTION } = {}) {
  const age = (item) => (item.lastModified ? now - new Date(item.lastModified).getTime() : 0);
  const old = (item) => age(item) >= retention.minAgeMs;

  // Nothing references this post any more: the whole prefix goes — but not
  // while a published revision is inside the rollback window. A post unpublished
  // without a draft, such as one migrated from the repository, has nothing else
  // keeping it, and could not be put back an hour later.
  if (record.state === "orphan") {
    const restorable = record.revisions.some((r) => r.kind === "published" && age(r) < retention.publishedRevisionMs);
    if (restorable) return [];
    return [
      ...record.revisions, ...record.media, ...record.uploads,
      ...record.attachments, ...record.interactives,
    ].filter(old);
  }

  const doomed = [];

  for (const revision of record.revisions) {
    if (revision.current) continue; // never the live one
    if (!old(revision)) continue;
    if (revision.kind === "published") {
      // Superseded, but keep it while rollback is still offered.
      if (age(revision) >= retention.publishedRevisionMs) doomed.push(revision);
    }
  }

  // Draft history: newest first, bounded by count and by age.
  const history = record.revisions
    .filter((r) => r.kind === "draft" && !r.current)
    .sort((a, b) => b.revisionId.localeCompare(a.revisionId));
  history.forEach((revision, position) => {
    if (!old(revision)) return;
    if (position >= retention.draftRevisionsPerPost || age(revision) >= retention.draftRevisionMs) {
      doomed.push(revision);
    }
  });

  // Uploads never attached to anything.
  for (const upload of record.uploads) {
    if (old(upload) && age(upload) >= retention.pendingUploadMs) doomed.push(upload);
  }

  // An interactive revision whose files are present but whose manifest is not
  // is an interrupted upload. The manifest is a bundle's commit point
  // (lib/server/interactives.mjs), so its absence is decidable from the key
  // listing alone — no revision body to read — and these would otherwise be the
  // one kind of object a live post accumulates forever.
  const revisions = new Map();
  for (const item of record.interactives) {
    if (item.kind !== "interactive-file" && item.kind !== "interactive-manifest") continue;
    const group = `${item.interactiveId}/${item.revisionId}`;
    if (!revisions.has(group)) revisions.set(group, { committed: false, files: [] });
    const entry = revisions.get(group);
    if (item.kind === "interactive-manifest") entry.committed = true;
    else entry.files.push(item);
  }
  for (const entry of revisions.values()) {
    if (entry.committed) continue;
    for (const file of entry.files) {
      if (old(file) && age(file) >= retention.pendingUploadMs) doomed.push(file);
    }
  }

  // Media, attachments and complete interactive bundles of a live post are kept:
  // they are in use, in a revision someone may roll back to, or a name claim
  // that keeps a published URL from ever being reused for different bytes.
  //
  // Superseded *bundle* revisions are the one case that could be collected and
  // is not. Published revisions do now record the interactive revisions they
  // use, so the information exists; what is missing is a sweep that reads every
  // stored revision of every post and still respects the rollback window, where
  // an older revision keeps its bundles alive. Keeping a bundle nobody
  // references costs storage; deleting one a rollback needs breaks a published
  // page. An interrupted upload is a different case and is swept above.
  return doomed;
}

/**
 * Delete what a post no longer needs.
 *
 * Dry by default. Every caller wanting deletion says so, because the failure
 * mode is losing work rather than wasting a byte.
 */
export async function collectGarbage(store, {
  apply = false,
  now = () => Date.now(),
  retention = RETENTION,
  maxDeletions = 500,
  inventory,
  postId,
} = {}) {
  const tree = inventory ?? await buildInventory(store, { now });
  const timestamp = now();

  const scope = postId ? tree.posts.filter((p) => p.postId === postId) : tree.posts;
  const candidates = [];
  for (const record of scope) {
    for (const item of collectableForPost(record, { now: timestamp, retention })) {
      candidates.push({ ...item, postId: record.postId });
    }
  }

  const doomed = candidates.slice(0, maxDeletions);
  let deleted = 0;
  if (apply) {
    for (const item of doomed) {
      await store.delete(item.key);
      deleted++;
    }
  }

  return {
    apply,
    scope: postId ?? "all",
    scanned: tree.totals.objects,
    deletable: candidates.length,
    deleted,
    truncated: candidates.length > doomed.length,
    bytesFreed: doomed.reduce((sum, o) => sum + (o.size ?? 0), 0),
    unknownKeys: tree.unknownKeys,
    keys: doomed.map((o) => o.key),
  };
}

/**
 * Delete a post outright: every prefix it owns, and nothing else.
 *
 * The whole point of the naming scheme. No graph to walk, no chance of reaching
 * another post's objects.
 */
export async function deletePostObjects(store, postId, { apply = false } = {}) {
  const doomed = [];
  for (const prefix of ownedPrefixes(postId)) {
    for (const object of await store.listAll(prefix)) doomed.push(object.key);
  }
  // Every key came from a prefix containing this post's id; belt and braces.
  const foreign = doomed.filter((key) => classifyKey(key).postId !== postId);
  if (foreign.length) {
    throw new Error(`refusing to delete keys not owned by ${postId}: ${foreign.join(", ")}`);
  }
  if (apply) for (const key of doomed) await store.delete(key);
  return { apply, postId, deletable: doomed.length, deleted: apply ? doomed.length : 0, keys: doomed };
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
  const t = inventory.totals;
  const lines = [
    `weblog inventory — ${t.posts} post(s): ${t.published} published, ${t.drafts} draft, ` +
    `${t.orphans} orphaned · ${t.objects} objects, ${kb(t.bytes)}`,
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
    const files = post.attachments.filter((a) => a.kind === "attachment-blob");
    const bundles = post.interactives.filter((i) => i.kind === "interactive-manifest");
    for (const [label, items] of [
      ["media", post.media], ["attachments", files],
      ["pending uploads", post.uploads], ["interactive bundles", bundles],
    ]) {
      if (!items.length) continue;
      lines.push(`  ${label} (${items.length}):`);
      for (const item of items) lines.push(`    ${item.name}  ${kb(item.size)}`);
    }
    lines.push("");
  }

  if (inventory.unknownKeys.length) {
    lines.push(`unrecognised keys (${inventory.unknownKeys.length}) — never auto-deleted:`);
    for (const key of inventory.unknownKeys) lines.push(`  ${key}`);
    lines.push("");
  }
  lines.push("* = current");
  return lines.join("\n");
}
