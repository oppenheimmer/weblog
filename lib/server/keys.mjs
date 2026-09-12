// The single place that knows how objects are named in R2.
//
// Every object belonging to a post carries that post's id as a path segment.
// Ownership is therefore readable straight off the key, with no lookup and no
// index to consult — which is what lets deletion be *scoped* to one post rather
// than computed across the whole bucket. A bug in the collector can then only
// ever damage the post it was already working on.
//
// Two consequences, both deliberate:
//
//   * Keys use the post id, never the slug. Slugs are human-chosen and
//     reusable: delete a post, create another with the same title, and the new
//     one would inherit the old one's directory. Ids are unforgeable and
//     permanent. Public URLs stay slug-based and readable — the build maps one
//     to the other, so storage safety and pretty URLs are not in tension.
//   * Nothing is shared between posts. The same image used in three posts is
//     stored three times. That forgoes deduplication so that deleting a post
//     can never remove a file another post is still using.
//
// Routes must build keys through this module rather than by hand.

/** `<postId>` is the ownership prefix. Everything below hangs off it. */
export const POST_ID_PATTERN = /^p_[0-9a-f]{16}$/;

export const keys = {
  // --- drafts -------------------------------------------------------------
  draftPointer: (postId) => `drafts/${postId}/current.json`,
  draftRevision: (postId, revisionId) => `drafts/${postId}/revisions/${revisionId}.json`,
  draftPrefix: (postId) => `drafts/${postId}/`,

  // --- published ----------------------------------------------------------
  publishedRevision: (postId, revisionId) => `published/posts/${postId}/${revisionId}.json`,
  publishedPrefix: (postId) => `published/posts/${postId}/`,

  // Media is stored under the post id; the *name* stays human-readable and is
  // what appears in the public URL.
  media: (postId, name) => `published/media/${postId}/${name}`,
  mediaPrefix: (postId) => `published/media/${postId}/`,

  // --- uploads ------------------------------------------------------------
  // Pending uploads are owned from the moment they are signed, so an abandoned
  // upload for a deleted post is caught by prefix rather than only by age.
  upload: (postId, uploadId, name) => `uploads/${postId}/${uploadId}/${name}`,
  // What we agreed to sign. Written by the server beside the file slot, never
  // reachable by the presigned URL, which covers the exact `file` key only.
  uploadIntent: (postId, uploadId) => `uploads/${postId}/${uploadId}/intent.json`,
  uploadPrefix: (postId) => `uploads/${postId}/`,

  // --- attachments --------------------------------------------------------
  // Verified bytes, promoted out of uploads/. These keys are never signed for a
  // browser PUT, so a presigned URL that is still valid cannot replace content
  // that has already been checked.
  attachmentRecord: (postId, attachmentId) => `attachments/${postId}/${attachmentId}.json`,
  attachmentBlob: (postId, publicName) => `attachments/${postId}/files/${publicName}`,
  // One claim per public name, created conditionally, so two uploads racing for
  // "image.png" — every clipboard paste is called that — cannot both win. Kept
  // after the attachment is removed, so a name is never reused within a post and
  // a published URL never changes what it shows.
  attachmentName: (postId, publicName) => `attachments/${postId}/names/${publicName}.json`,
  attachmentPrefix: (postId) => `attachments/${postId}/`,

  // --- not owned by any post ----------------------------------------------
  publishedIndex: "published/index.json",
  inventory: "inventory.json",
  job: (jobId) => `publications/${jobId}.json`,
  session: (tokenHash) => `sessions/${tokenHash}.json`,
  // One key, rewritten by a build that fails and deleted by one that succeeds,
  // so its presence means "the most recent build failed" and it can never
  // accumulate. A record per build would need a retention rule; this needs none.
  lastBuildFailure: "builds/last-failure.json",
};

/** Every prefix a post owns. Deleting a post means deleting exactly these. */
export function ownedPrefixes(postId) {
  return [
    keys.draftPrefix(postId),
    keys.publishedPrefix(postId),
    keys.mediaPrefix(postId),
    keys.uploadPrefix(postId),
    keys.attachmentPrefix(postId),
  ];
}

const OWNED = [
  { kind: "draft-pointer", pattern: /^drafts\/(p_[0-9a-f]{16})\/current\.json$/ },
  { kind: "draft-revision", pattern: /^drafts\/(p_[0-9a-f]{16})\/revisions\/(r_[^/]+)\.json$/ },
  { kind: "published-revision", pattern: /^published\/posts\/(p_[0-9a-f]{16})\/(r_[^/]+)\.json$/ },
  { kind: "media", pattern: /^published\/media\/(p_[0-9a-f]{16})\/(.+)$/ },
  { kind: "upload", pattern: /^uploads\/(p_[0-9a-f]{16})\/([^/]+)\/(.+)$/ },
  { kind: "attachment-record", pattern: /^attachments\/(p_[0-9a-f]{16})\/(a_[0-9a-f]{16})\.json$/ },
  { kind: "attachment-blob", pattern: /^attachments\/(p_[0-9a-f]{16})\/files\/([^/]+)$/ },
  { kind: "attachment-name", pattern: /^attachments\/(p_[0-9a-f]{16})\/names\/([^/]+)\.json$/ },
];

const UNOWNED = [
  { kind: "index", pattern: /^published\/index\.json$/ },
  { kind: "inventory", pattern: /^inventory\.json$/ },
  { kind: "job", pattern: /^publications\/[^/]+\.json$/ },
  // Expire on their own schedule; never this collector's business.
  { kind: "session", pattern: /^sessions\// },
  { kind: "rate-limit", pattern: /^rate-limits\// },
  // Written by the build, not by a post. Never collectable: the build that
  // succeeds is what removes it.
  { kind: "build-failure", pattern: /^builds\// },
];

/**
 * Read a key's owner and role.
 *
 * `kind: "unknown"` means the key matches no convention at all. Those are
 * reported, never deleted automatically: an unrecognised key is more likely to
 * mean this function is out of date than that the object is rubbish.
 */
export function classifyKey(key) {
  for (const { kind, pattern } of OWNED) {
    const match = key.match(pattern);
    if (match) {
      return { kind, owned: true, postId: match[1], id: match[2] ?? null, name: match[3] ?? match[2] ?? null };
    }
  }
  for (const { kind, pattern } of UNOWNED) {
    if (pattern.test(key)) return { kind, owned: false, postId: null };
  }
  return { kind: "unknown", owned: false, postId: null };
}

/** Public URL for a published attachment. Slug-based, so readers see prose. */
export function mediaUrl(slug, name) {
  return `/images/uploads/${slug}/${name}`;
}
