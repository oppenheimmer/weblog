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
import { normalizePost, ContentError, RESERVED_SLUGS } from "../content.mjs";

export const PUBLISHED_SCHEMA_VERSION = 1;

export const INDEX_KEY = "published/index.json";
export const revisionKey = (postId, revisionId) => `published/posts/${postId}/${revisionId}.json`;
const jobKey = (jobId) => `publications/${jobId}.json`;

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
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const emptyIndex = () => ({
  schemaVersion: PUBLISHED_SCHEMA_VERSION,
  updatedAt: null,
  posts: {},
});

/**
 * Validate a draft as a *post*, which is stricter than validating it as a draft.
 * A draft may be half-written; a published post may not.
 */
export function validateForPublish(draft) {
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

export function createPublisher(store, {
  now = () => new Date().toISOString(),
  fireDeployHook = defaultDeployHook,
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
      const slug = validateForPublish(draft);
      const key = idempotencyKey ?? `${draft.postId}:${draft.revisionId}`;
      const jobId = `j_${sha(key)}`;

      const existing = await api.getJob(jobId);
      if (existing && existing.state !== "failed") return existing;

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
        body: draft.body,
        // Author's explicit math override, when set. The styles/scripts/head/
        // distill hooks are deliberately NOT carried: they are engine-trusted
        // and browser-authored content must never be able to set them (§3.1).
        ...(draft.math === undefined ? {} : { math: draft.math }),
        attachments: draft.attachments ?? [],
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
