// Build-side reader: published R2 content -> post objects (CLAUDE.md §1.1).
//
// The build's only source of content. It goes through exactly the same pipeline
// as the filesystem reader, so a post renders identically whichever way it
// arrived.
import { createStore } from "./r2.mjs";
import { createPublisher } from "./publish.mjs";
import { normalizePost, collectPosts } from "../content.mjs";

/** Fetch every published post and render it. Read-only; no credentials to write. */
export async function loadPublishedPosts({ store = createStore() } = {}) {
  const publisher = createPublisher(store);
  const revisions = await publisher.listPublished();

  const posts = [];
  for (const revision of revisions) {
    const post = normalizePost({
      data: {
        title: revision.title,
        date: revision.date,
        description: revision.description,
        tags: revision.tags,
        slug: revision.slug,
      },
      body: revision.body,
      format: revision.format,
      sourceName: `${revision.slug} (${revision.revisionId})`,
    });
    // A published revision is never a draft; normalizePost returns null only
    // for drafts, so this would mean the stored record is malformed.
    if (!post) continue;
    posts.push({ ...post, revisionId: revision.revisionId, postId: revision.postId });
  }
  return collectPosts(posts);
}

/**
 * A small manifest of what this build contains, so Step 7 can verify that a
 * deployment is actually serving the revision it was asked to.
 */
export function buildManifest(posts, { commit = process.env.VERCEL_GIT_COMMIT_SHA ?? null } = {}) {
  // No timestamp: see build.mjs — determinism matters more than provenance here.
  return {
    commit,
    posts: posts.map((p) => ({ slug: p.slug, postId: p.postId ?? null, revisionId: p.revisionId ?? null })),
  };
}
