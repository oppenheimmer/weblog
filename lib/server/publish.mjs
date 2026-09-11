// Publication: freeze a draft into R2, then ask Vercel to rebuild
// (CLAUDE.md §3.2, Step 6).
//
// Two durable steps, in this order and no other:
//
//   1. Write an immutable revision, then update the slug index conditionally.
//      The index update is the commit point — before it the post is not
//      published, after it it is. There is no moment where it is half-published.
//   2. Fire the deploy hook. Only ever after the index write, because firing
//      first would build content that does not exist yet.
//
// The build is not waited on. A publish is durable as soon as R2 says so; the
// deployment that follows is Step 7's problem, not this module's.
import crypto from "node:crypto";

import { ConflictError } from "./r2.mjs";
import { keys } from "./keys.mjs";
import { onStateChange } from "./inventory.mjs";
import { createUploads } from "./uploads.mjs";
import { normalizePost, ContentError, RESERVED_SLUGS } from "../content.mjs";
import { resolveReferences, validateAttachments, AttachmentError } from "../attachments.mjs";

export const PUBLISHED_SCHEMA_VERSION = 1;

export const INDEX_KEY = keys.publishedIndex;
export const revisionKey = keys.publishedRevision;
const jobKey = keys.job;

export class PublishError extends Error {
  constructor(message, { code = "publish_failed", status = 400, field } = {}) {
    super(message);
    this.name = "PublishError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export const newJobId = () => `j_${crypto.randomBytes(8).toString("hex")}`;

/** Stable digest of what is actually being published, for later verification. */
export function contentDigest(revision) {
  const canonical = JSON.stringify({
    title: revision.title, date: revision.date, slug: revision.slug,
    description: revision.description, tags: revision.tags,
    format: revision.format, body: revision.body,
    // Only when present, so a post without images keeps the digest it had
    // before media existed.
    ...(revision.media?.length ? { media: revision.media.map((m) => m.sha256) } : {}),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const emptyIndex = () => ({
  schemaVersion: PUBLISHED_SCHEMA_VERSION,
  updatedAt: null,
  posts: {},
});

/** The checks that need neither rendering nor storage, so they can run first. */
export function validateMetadata(draft) {
  if (!draft) throw new PublishError("No draft to publish.", { status: 404, code: "not_found" });

  for (const [field, label] of [["title", "a title"], ["date", "a date"], ["body", "a body"]]) {
    if (!String(draft[field] ?? "").trim()) {
      throw new PublishError(`This post needs ${label} before it can be published.`, { field });
    }
  }

  const slug = draft.slug;
  if (!slug) throw new PublishError("This post needs a slug.", { field: "slug" });
  if (RESERVED_SLUGS.has(slug)) {
    throw new PublishError(`"${slug}" is a reserved URL and cannot be used.`, { field: "slug" });
  }
  return slug;
}

/**
 * Validate a draft as a *post*, which is stricter than validating it as a draft.
 * A draft may be half-written; a published post may not.
 */
export function validateForPublish(draft) {
  const slug = validateMetadata(draft);

  // Render it now. A post that cannot be rendered must never reach the build,
  // where the failure would take the whole site's deployment down with it.
  try {
    normalizePost({
      data: {
        title: draft.title, date: draft.date, description: draft.description,
        tags: draft.tags, slug: draft.slug,
      },
      body: draft.body,
      format: draft.format,
      sourceName: `${slug}.${draft.format === "latex" ? "tex" : "md"}`,
    });
  } catch (err) {
    if (err instanceof ContentError) {
      throw new PublishError(err.message, { field: err.field, code: "invalid_content" });
    }
    throw err;
  }

  return slug;
}

/**
 * Resolve `attachment://` against a post's own verified files (§4.2).
 *
 * Returns the body with final public paths, and the images it shows with the
 * hashes the build will verify them against. Snippets are inlined into the
 * body, so only images need an entry.
 *
 * Exported so preview runs this exact function: whatever publishing would
 * refuse, preview reports, and the two cannot drift apart.
 */
export async function resolveForPublish(draft, uploads) {
  const attachments = await uploads.list(draft.postId);
  try {
    validateAttachments(attachments);
    const snippets = await uploads.snippetTexts(draft.postId, attachments);
    const resolved = resolveReferences(draft.body, {
      format: draft.format,
      slug: draft.slug,
      postId: draft.postId,
      attachments,
      snippets,
    });
    const byId = new Map(attachments.map((a) => [a.id, a]));
    const media = resolved.used
      .map((id) => byId.get(id))
      .filter((a) => a?.kind === "image")
      .map(({ id, publicName, mediaType, bytes, sha256, width, height }) =>
        ({ id, publicName, mediaType, bytes, sha256, width, height }))
      .sort((a, b) => a.publicName.localeCompare(b.publicName));
    return { body: resolved.body, media };
  } catch (err) {
    if (err instanceof AttachmentError) {
      throw new PublishError(err.message, { code: err.code, field: err.field });
    }
    throw err;
  }
}

export function createPublisher(store, {
  now = () => new Date().toISOString(),
  fireDeployHook = defaultDeployHook,
  uploads = createUploads(store),
} = {}) {
  const api = {
    async readIndex() {
      const record = await store.getJson(INDEX_KEY);
      return record ?? { data: emptyIndex(), etag: null };
    },

    /** Everything currently published, newest first. Used by the build. */
    async listPublished() {
      const { data: index } = await api.readIndex();
      const entries = Object.entries(index.posts ?? {});
      const revisions = await Promise.all(entries.map(async ([slug, entry]) => {
        const record = await store.getJson(revisionKey(entry.postId, entry.revisionId));
        return record ? { slug, ...record.data } : null;
      }));
      return revisions.filter(Boolean);
    },

    async getJob(jobId) {
      const record = await store.getJson(jobKey(jobId));
      return record?.data ?? null;
    },

    /**
     * Publish a draft.
     *
     * Idempotent by default. The key falls back to the post and revision being
     * published, so a double-click or a retry after a timeout returns the
     * original job rather than publishing again and firing a second rebuild.
     *
     * An earlier version required the caller to supply the key and quietly lost
     * idempotency whenever one forgot — a footgun that the route happened to
     * avoid and a direct caller did not. Callers may still pass a key to make a
     * republish of the same revision deliberate.
     */
    async publish(draft, { idempotencyKey } = {}) {
      validateMetadata(draft);
      const key = idempotencyKey ?? `${draft.postId}:${draft.revisionId}`;
      const jobId = `j_${sha(key)}`;

      const existing = await api.getJob(jobId);
      if (existing && existing.state !== "failed") return existing;

      // Resolve before the rendered check, so what is validated is the body that
      // will actually be published, final image paths and all.
      const { body, media } = await resolveForPublish(draft, uploads);
      const slug = validateForPublish({ ...draft, body });

      const timestamp = now();
      const revision = {
        schemaVersion: PUBLISHED_SCHEMA_VERSION,
        postId: draft.postId,
        revisionId: draft.revisionId,
        draftVersion: draft.version,
        slug,
        title: draft.title,
        date: draft.date,
        description: draft.description ?? "",
        tags: draft.tags ?? [],
        format: draft.format,
        body,
        // Author's explicit math override, when set. The styles/scripts/head/
        // distill hooks are deliberately NOT carried: they are engine-trusted
        // and browser-authored content must never be able to set them (§3.1).
        ...(draft.math === undefined ? {} : { math: draft.math }),
        // Exactly the images this revision shows, each with the hash the build
        // verifies it against.
        media,
        publishedAt: timestamp,
      };
      const digest = contentDigest(revision);

      let job = {
        jobId,
        postId: draft.postId,
        revisionId: draft.revisionId,
        slug,
        digest,
        state: "writing",
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 1,
        error: null,
      };
      // Durable before any external effect, so an interrupted publish is
      // recoverable rather than invisible.
      await store.putJson(jobKey(jobId), job);

      try {
        // Media before the revision, and both before the commit point: once the
        // index names this revision a build may run, and every image it shows
        // must already be in place. Copied from the verified attachment — a key
        // no presigned URL can write to.
        for (const item of media) {
          await store.copy(
            keys.attachmentBlob(draft.postId, item.publicName),
            keys.media(draft.postId, item.publicName)
          );
        }

        // Immutable, so a repeat is harmless.
        await store.putJson(revisionKey(draft.postId, draft.revisionId), revision);

        // The commit point. Conditional on the index's ETag, so two publishes
        // racing for one slug cannot both win.
        const { data: index, etag } = await api.readIndex();
        const claimed = index.posts?.[slug];
        if (claimed && claimed.postId !== draft.postId) {
          throw new PublishError(
            `The URL /${slug}/ is already used by another post.`,
            { code: "slug_taken", status: 409, field: "slug" }
          );
        }

        const nextIndex = {
          ...index,
          schemaVersion: PUBLISHED_SCHEMA_VERSION,
          updatedAt: timestamp,
          posts: {
            ...index.posts,
            [slug]: {
              postId: draft.postId,
              revisionId: draft.revisionId,
              digest,
              publishedAt: timestamp,
            },
          },
        };
        await (etag
          ? store.updateJson(INDEX_KEY, nextIndex, etag)
          : store.createJson(INDEX_KEY, nextIndex));

        job = { ...job, state: "published", updatedAt: now() };
        await store.putJson(jobKey(jobId), job);
      } catch (err) {
        const failed = {
          ...job,
          state: "failed",
          updatedAt: now(),
          error: err instanceof PublishError || err instanceof ConflictError
            ? err.message
            : "The publish could not be completed.",
        };
        await store.putJson(jobKey(jobId), failed);
        throw err;
      }

      // Past the commit point: the post IS published. A hook failure means it
      // is not yet *live*, which is a different and recoverable state, so it
      // must not be reported as a failed publish.
      try {
        const hook = await fireDeployHook();
        job = { ...job, state: "building", deployHook: hook ?? null, updatedAt: now() };
      } catch (err) {
        job = {
          ...job,
          state: "published",
          hookError: `Published, but the rebuild could not be triggered: ${err.message}`,
          updatedAt: now(),
        };
      }
      await store.putJson(jobKey(jobId), job);

      // Housekeeping, never load-bearing: onStateChange swallows its own
      // failures so a successful publish is never reported as a failed one.
      await onStateChange(store);
      return job;
    },

    /** Remove a post from the index. The revision stays for rollback. */
    async unpublish(slug) {
      const { data: index, etag } = await api.readIndex();
      if (!index.posts?.[slug]) return { ok: true, changed: false };

      const posts = { ...index.posts };
      delete posts[slug];
      await store.updateJson(INDEX_KEY, { ...index, posts, updatedAt: now() }, etag);
      try {
        await fireDeployHook();
      } catch { /* unpublished regardless; the next build will reflect it */ }
      await onStateChange(store);
      return { ok: true, changed: true };
    },
  };

  return api;
}

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

/**
 * Ask Vercel to rebuild.
 *
 * Absent configuration is not an error: a preview or a local run should be able
 * to publish to its own prefix without triggering a production build.
 */
export async function defaultDeployHook(url = process.env.VERCEL_DEPLOY_HOOK_URL) {
  if (!url) return { skipped: "no deploy hook configured" };
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`deploy hook responded ${res.status}`);
  }
  const body = await res.json().catch(() => ({}));
  return { job: body?.job?.id ?? null, state: body?.job?.state ?? null };
}
