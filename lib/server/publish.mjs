// Publication: freeze a draft into R2, then ask Vercel to rebuild
// (CLAUDE.md §3.2, Step 6, Step 7).
//
// Two durable steps, in this order and no other:
//
//   1. Write an immutable revision, then update the slug index conditionally.
//      The index update is the commit point — before it the post is not
//      published, after it it is. There is no moment where it is half-published.
//   2. Fire the deploy hook. Only ever after the index write, because firing
//      first would build content that does not exist yet.
//
// The build is not waited on. A publish is durable as soon as R2 says so;
// whether the site shows it yet is read back from the deployment itself
// (lib/server/deployments.mjs).
//
// Every later change to what the site shows has the same shape: one
// conditional index update, then a rebuild. Unpublishing removes a post's
// entry; rolling back points it at a revision already stored.
import crypto from "node:crypto";

import { ConflictError } from "./r2.mjs";
import { keys, classifyKey, POST_ID_PATTERN } from "./keys.mjs";
import { onStateChange } from "./inventory.mjs";
import { createUploads } from "./uploads.mjs";
import { normalizePost, ContentError, RESERVED_SLUGS } from "../content.mjs";
import { resolveReferences, validateAttachments, AttachmentError, attachmentUrl } from "../attachments.mjs";
import { resolveInteractiveReferences, InteractiveError, publicBundlePath } from "../interactives.mjs";
import { createInteractives } from "./interactives.mjs";

export const PUBLISHED_SCHEMA_VERSION = 1;

export const INDEX_KEY = keys.publishedIndex;
export const revisionKey = keys.publishedRevision;
const jobKey = keys.job;

// A job still "writing" after this long was interrupted: the function running
// it has been stopped. Longer than a function may run, so a publish still in
// progress is never overtaken. Every step is safe to repeat, so resuming means
// running the publish again.
export const WRITE_LEASE_MS = 10 * 60 * 1000;

const REVISION_ID_PATTERN = /^r_[0-9a-z_]+$/;

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

/** The job a publish is recorded under. The same revision always maps to the same job. */
export const jobIdFor = (draft, idempotencyKey) =>
  `j_${sha(idempotencyKey ?? `${draft.postId}:${draft.revisionId}`)}`;

/** Stable digest of what is actually being published, for later verification. */
export function contentDigest(revision) {
  const canonical = JSON.stringify({
    title: revision.title, date: revision.date, slug: revision.slug,
    description: revision.description, tags: revision.tags,
    format: revision.format, body: revision.body,
    // Only when present, so a post without images keeps the digest it had
    // before media existed.
    ...(revision.media?.length ? { media: revision.media.map((m) => m.sha256) } : {}),
    ...(revision.interactives?.length
      ? { interactives: revision.interactives.map((i) => `${i.id}@${i.revisionId}`) }
      : {}),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const emptyIndex = () => ({
  schemaVersion: PUBLISHED_SCHEMA_VERSION,
  updatedAt: null,
  posts: {},
  // A post disappears from `posts` when unpublished, but the editor still has
  // to know which stored revision was last shown. Kept in the same object so
  // removing the live entry and remembering it are one conditional write.
  unpublished: {},
});

/** The draft version a revision id was saved as (lib/server/drafts.mjs), or null. */
export function revisionVersion(revisionId) {
  const match = /^r_(\d+)_/.exec(String(revisionId));
  return match ? Number(match[1]) : null;
}

/**
 * Refuse an address that would give a post two URLs, or two posts one.
 *
 * A slug another post holds is refused. So is moving a published post to a new
 * slug: the index would gain a second entry for the same post, and the build
 * would emit it at both addresses. §4.1 fixes a post's slug while it is
 * published; unpublishing frees it.
 */
function checkAddress(index, { postId, slug }) {
  const posts = index?.posts ?? {};
  const holder = posts[slug];
  if (holder && holder.postId !== postId) {
    throw new PublishError(
      `The URL /${slug}/ is already used by another post.`,
      { code: "slug_taken", status: 409, field: "slug" }
    );
  }
  const current = Object.keys(posts).find((key) => posts[key].postId === postId);
  if (current !== undefined && current !== slug) {
    throw new PublishError(
      `This post is published at /${current}/, and its address cannot change while it is published. ` +
      "Change the slug back, or unpublish the post first.",
      { code: "slug_locked", status: 409, field: "slug" }
    );
  }
}

/**
 * The index with `slug` pointing at `entry`, for a conditional update.
 * Undefined when it already does, so a repeat writes nothing.
 */
function placeInIndex(index, { postId, slug, entry, timestamp }) {
  checkAddress(index, { postId, slug });
  const base = index ?? emptyIndex();
  if (base.posts?.[slug]?.revisionId === entry.revisionId) return undefined;
  const { [postId]: _forgotten, ...unpublished } = base.unpublished ?? {};
  return {
    ...base,
    schemaVersion: PUBLISHED_SCHEMA_VERSION,
    updatedAt: timestamp,
    posts: { ...base.posts, [slug]: entry },
    unpublished,
  };
}

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
export async function resolveForPublish(draft, uploads, bundles) {
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
    // For saying what a post publishes with before it is published: the
    // snippets it inlines, including through another snippet, and what is
    // attached but not used anywhere.
    const usedIds = new Set(resolved.used);
    const names = (list) => list.map((a) => a.publicName).sort((a, b) => a.localeCompare(b));
    const snippetNames = names(attachments.filter((a) => a.kind === "tex" && usedIds.has(a.id)));
    const unused = names(attachments.filter((a) => !usedIds.has(a.id)));

    // Interactives resolve after attachments, over the already-rewritten body.
    // The two reference forms cannot collide — one is a URL scheme and an image
    // directive, the other is `::demo[…]` — and both skip code regions.
    const records = bundles ? await bundles.list(draft.postId) : [];
    const fallbacks = bundles ? await bundles.fallbackTexts(draft.postId, records) : new Map();
    const withBundles = resolveInteractiveReferences(resolved.body, {
      format: draft.format,
      slug: draft.slug,
      postId: draft.postId,
      interactives: records,
      fallbacks,
    });
    const usedBundles = new Set(withBundles.used);
    // One revision per interactive: the one the body now names. Records come
    // oldest first and the resolver keeps the last of each id, so this keeps
    // the same one. Filtering records by id alone listed every stored revision
    // of a used interactive, and the build emitted all of them.
    const resolvedRevisions = new Map(records.map((record) => [record.id, record]));
    const interactives = [...resolvedRevisions.values()]
      .filter((record) => usedBundles.has(record.id))
      .map(({ id, kind, name, revisionId, entry, fallback, dependencies, files }) =>
        ({ id, kind, name, revisionId, entry, fallback, dependencies, files }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { body: withBundles.body, media, interactives, snippets: snippetNames, unused };
  } catch (err) {
    if (err instanceof AttachmentError || err instanceof InteractiveError) {
      throw new PublishError(err.message, { code: err.code, field: err.field });
    }
    throw err;
  }
}

export function createPublisher(store, {
  now = () => new Date().toISOString(),
  fireDeployHook = defaultDeployHook,
  uploads = createUploads(store),
  interactives: interactiveStore = createInteractives(store),
  // Injectable so a test can see that a sweep was asked for, and with what.
  housekeep = onStateChange,
} = {}) {
  /** Fire the hook for a job past its commit point, and record the outcome on the job. */
  async function triggerBuild(job) {
    const { hookError, ...rest } = job;
    const result = await api.rebuild();
    const next = result.triggered
      ? { ...rest, state: "building", deployHook: result.hook, updatedAt: now() }
      : {
          ...rest,
          state: "published",
          hookError: `Published, but the rebuild could not be triggered: ${result.error}`,
          updatedAt: now(),
        };
    await store.putJson(jobKey(job.jobId), next);
    return next;
  }

  const assertPostId = (postId) => {
    if (typeof postId !== "string" || !POST_ID_PATTERN.test(postId)) {
      throw new PublishError("Unknown post.", { code: "invalid_post", field: "postId" });
    }
  };

  // What an unsaved post resolves against: nothing, which is exactly what it
  // will have when Publish saves it first.
  const NOTHING_ATTACHED = {
    uploads: { list: async () => [], snippetTexts: async () => new Map() },
    interactives: { list: async () => [], fallbackTexts: async () => new Map() },
  };

  /**
   * Everything publishing decides before its first write, and nothing it writes.
   *
   * The frozen body, the images and bundles it carries — inherited from the
   * published revision a draft branched from, or resolved from its own verified
   * files — the rendered check, and whether the address is free. `publish` and
   * `check` both call this, which is what keeps "ready" and "published" from
   * ever disagreeing.
   */
  async function prepareRevision(draft, sources = {}) {
    const attachmentsFrom = sources.uploads ?? uploads;
    const bundlesFrom = sources.interactives ?? interactiveStore;

    // Resolve before the rendered check, so what is validated is the body that
    // will actually be published, final image paths and all.
    // A publication-only post starts from an already-resolved revision: its
    // images and bundles use public URLs rather than attachment:// ids. Carry
    // forward only assets whose exact public paths remain in the edited body,
    // and rewrite those paths if an unpublished post takes a new slug.
    let sourceBody = draft.body;
    const inheritedMedia = [];
    const inheritedInteractives = [];
    if (draft.publishedRevisionId) {
      const source = await store.getJson(revisionKey(draft.postId, draft.publishedRevisionId));
      if (!source || source.data.postId !== draft.postId) {
        throw new PublishError("The published revision this draft began from is no longer stored.", {
          code: "source_revision_missing", status: 409,
        });
      }
      for (const item of source.data.media ?? []) {
        const oldUrl = attachmentUrl(source.data.slug, item.publicName);
        if (!sourceBody.includes(oldUrl)) continue;
        sourceBody = sourceBody.split(oldUrl).join(attachmentUrl(draft.slug, item.publicName));
        inheritedMedia.push(item);
      }
      for (const bundle of source.data.interactives ?? []) {
        const oldPath = publicBundlePath(bundle.kind, source.data.slug, bundle.name, bundle.revisionId);
        if (!sourceBody.includes(oldPath)) continue;
        sourceBody = sourceBody.split(oldPath)
          .join(publicBundlePath(bundle.kind, draft.slug, bundle.name, bundle.revisionId));
        inheritedInteractives.push(bundle);
      }
    }

    const resolved = await resolveForPublish({ ...draft, body: sourceBody }, attachmentsFrom, bundlesFrom);
    const body = resolved.body;
    const media = [...new Map([...inheritedMedia, ...resolved.media]
      .map((item) => [item.publicName, item])).values()]
      .sort((a, b) => a.publicName.localeCompare(b.publicName));
    const interactives = [...new Map([...inheritedInteractives, ...resolved.interactives]
      .map((item) => [`${item.kind}:${item.name}:${item.revisionId}`, item])).values()]
      .sort((a, b) => a.name.localeCompare(b.name));
    const slug = validateForPublish({ ...draft, body });

    // Refuse an address clash before writing anything, so a refused publish
    // leaves no stored revision to be offered for rollback later. The
    // conditional update in publish checks again, and that is the check that
    // counts.
    checkAddress((await api.readIndex()).data, { postId: draft.postId ?? null, slug });

    return { slug, body, media, interactives, snippets: resolved.snippets, unused: resolved.unused };
  }

  const api = {
    async readIndex() {
      const record = await store.getJson(INDEX_KEY);
      return record ?? { data: emptyIndex(), etag: null };
    },

    /** Every indexed revision. A missing one must fail the build, not omit a post. */
    async listPublished() {
      const { data: index } = await api.readIndex();
      const entries = Object.entries(index.posts ?? {});
      return Promise.all(entries.map(async ([slug, entry]) => {
        const record = await store.getJson(revisionKey(entry.postId, entry.revisionId));
        if (!record) {
          throw new ContentError(
            `Published revision for /${slug}/ is missing: ${entry.revisionId}.`,
          );
        }
        return { slug, ...record.data };
      }));
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
     *
     * A repeat is also how a publish that stopped part way is finished. One
     * that failed, or was interrupted before its commit point, runs again. One
     * past its commit point whose rebuild was never confirmed only fires the
     * hook. One still running, or already rebuilding, is returned as it is.
     *
     * Idempotent only while the index still names the revision. Once the post
     * has been unpublished or rolled back, publishing the same revision is a new
     * change, not a repeat, and must not be answered with the old job.
     */
    async publish(draft, { idempotencyKey } = {}) {
      validateMetadata(draft);
      const jobId = jobIdFor(draft, idempotencyKey);

      const existing = await api.getJob(jobId);
      if (existing && existing.state !== "failed") {
        const idle = Date.parse(now()) - Date.parse(existing.updatedAt) >= WRITE_LEASE_MS;
        if (existing.state === "writing") {
          if (!idle) return existing;
        } else {
          const entry = (await api.readIndex()).data.posts?.[existing.slug];
          if (entry?.postId === existing.postId && entry?.revisionId === existing.revisionId) {
            return existing.state === "published" && (existing.hookError || idle) ? triggerBuild(existing) : existing;
          }
        }
        // Interrupted before its commit point, or taken off the site since:
        // publish it again.
      }

      const { slug, body, media, interactives } = await prepareRevision(draft);

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
        // Only when present, so a post with no interactive keeps the shape it
        // had before they existed — and the digest it had with it.
        ...(interactives.length ? { interactives } : {}),
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
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        attempts: (existing?.attempts ?? 0) + 1,
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
          const attachment = keys.attachmentBlob(draft.postId, item.publicName);
          if (await store.head(attachment)) {
            await store.copy(attachment, keys.media(draft.postId, item.publicName));
          } else if (!(await store.head(keys.media(draft.postId, item.publicName)))) {
            throw new PublishError(`The inherited image ${item.publicName} is no longer stored.`, {
              code: "media_missing", status: 409,
            });
          }
        }
        // Bundles the same way, and for the same reason: once the index names
        // this revision a build may run, and every file it serves must already
        // be in place. Copied from the verified bundle, a key no presigned URL
        // can write to.
        for (const bundle of interactives) {
          for (const file of bundle.files) {
            const source = keys.interactiveFile(draft.postId, bundle.id, bundle.revisionId, file.name);
            const published = keys.publishedInteractive(draft.postId, bundle.id, bundle.revisionId, file.name);
            if (await store.head(source)) await store.copy(source, published);
            else if (!(await store.head(published))) {
              throw new PublishError(`The inherited ${bundle.kind} ${bundle.name} is no longer stored.`, {
                code: "interactive_missing", status: 409,
              });
            }
          }
        }

        // Immutable, so a repeat is harmless.
        await store.putJson(revisionKey(draft.postId, draft.revisionId), revision);

        // The commit point. Conditional on the index's ETag, and re-decided on
        // a fresh read if another writer got there first, so two publishes
        // racing for one slug cannot both win.
        await store.mutateJson(INDEX_KEY, (index) => placeInIndex(index, {
          postId: draft.postId,
          slug,
          entry: { postId: draft.postId, revisionId: draft.revisionId, digest, publishedAt: timestamp },
          timestamp,
        }));

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
      job = await triggerBuild(job);

      // Housekeeping, never load-bearing: onStateChange swallows its own
      // failures so a successful publish is never reported as a failed one.
      await housekeep(store);
      return job;
    },

    /**
     * What Publish would do with this draft, without doing any of it (Step 5).
     *
     * Ready: the address and exactly the images, snippets and bundles it would
     * publish with, plus what is attached and unused. Not ready: publishing's
     * own refusal — code, field and message. Reads only. A draft with no post
     * id is checked as Publish would first save it, with nothing attached.
     */
    async check(draft) {
      try {
        validateMetadata(draft);
        const prepared = await prepareRevision(draft, draft.postId ? {} : NOTHING_ATTACHED);
        return {
          ready: true,
          slug: prepared.slug,
          url: `/${prepared.slug}/`,
          media: prepared.media.map((item) => item.publicName),
          snippets: prepared.snippets,
          interactives: prepared.interactives.map(({ kind, name }) => ({ kind, name })),
          unused: prepared.unused,
        };
      } catch (err) {
        if (!(err instanceof PublishError)) throw err;
        return { ready: false, refusal: { code: err.code, field: err.field ?? null, message: err.message } };
      }
    },

    /**
     * Fire the deploy hook. The primitive: every state change ends here, and
     * `triggerBuild` calls it, so it must stay free of side effects.
     */
    async rebuild() {
      try {
        return { triggered: true, hook: (await fireDeployHook()) ?? null };
      } catch (err) {
        return { triggered: false, error: err?.message ?? String(err) };
      }
    },

    /**
     * What the editor's Rebuild site button does: rebuild, and tidy up.
     *
     * Publishing, unpublishing, rolling back and discarding each sweep
     * afterwards, but nothing did when no post changed — so superseded
     * revisions past their 90 days, abandoned uploads and orphaned media had no
     * way out but `scripts/inventory.mjs --gc --apply`, which needs a terminal
     * and credentials. Rebuild is the one action about the site rather than a
     * post, which makes it the right home for the sweep that is also about the
     * site rather than a post.
     *
     * Kept separate from `rebuild()` deliberately: that one is called on every
     * publish, and sweeping there would do the same work twice for no reason.
     *
     * The sweep is housekeeping and never load-bearing — `housekeep` swallows
     * its own failures — and its guards are what make it safe behind a button:
     * nothing the live site needs is collectable, and nothing younger than an
     * hour is touched at all.
     */
    async rebuildSite() {
      const result = await api.rebuild();
      if (!result.triggered) return result;
      const housekeeping = await housekeep(store);
      return {
        ...result,
        swept: housekeeping.ok
          ? { objects: housekeeping.swept.deleted, bytes: housekeeping.swept.bytesFreed }
          : null,
      };
    },

    /**
     * Take a post off the site: remove its index entry, then rebuild.
     *
     * Its revisions and media stay, so it can be put back with rollback until
     * retention collects them (lib/server/inventory.mjs).
     */
    async unpublish(postId) {
      assertPostId(postId);
      let slug = null;
      await store.mutateJson(INDEX_KEY, (index) => {
        const posts = index?.posts ?? {};
        slug = Object.keys(posts).find((key) => posts[key].postId === postId) ?? null;
        if (slug === null) return undefined;
        const timestamp = now();
        const { [slug]: _removed, ...rest } = posts;
        return {
          ...index,
          posts: rest,
          unpublished: {
            ...(index?.unpublished ?? {}),
            [postId]: { slug, ...posts[slug], unpublishedAt: timestamp },
          },
          updatedAt: timestamp,
        };
      });
      if (slug === null) return { ok: true, changed: false };

      const rebuild = await api.rebuild();
      await housekeep(store);
      return { ok: true, changed: true, slug, ...rebuildOutcome(rebuild) };
    },

    /**
     * Put a stored revision of a post on the site (Step 7).
     *
     * An R2 operation rather than a Vercel one: the index is pointed at the
     * revision and the site rebuilt. A Vercel instant rollback would be undone
     * by the next unrelated build, which reads the index. The same call steps a
     * live post back and restores an unpublished one.
     */
    async rollback(postId, revisionId) {
      assertPostId(postId);
      const record = typeof revisionId === "string" && REVISION_ID_PATTERN.test(revisionId)
        ? await store.getJson(revisionKey(postId, revisionId))
        : null;
      if (!record || record.data.postId !== postId) {
        throw new PublishError("That revision is no longer stored.", { code: "not_found", status: 404 });
      }
      const revision = record.data;

      // A missing image stops the build, and with it every other post's update,
      // so a revision whose images retention has already collected is refused
      // here rather than there.
      for (const item of revision.media ?? []) {
        if (!(await store.head(keys.media(postId, item.publicName)))) {
          throw new PublishError(
            `That revision shows ${item.publicName}, which is no longer stored, so it cannot be put back.`,
            { code: "media_missing", status: 409 }
          );
        }
      }

      const timestamp = now();
      let changed = false;
      await store.mutateJson(INDEX_KEY, (index) => {
        const next = placeInIndex(index, {
          postId,
          slug: revision.slug,
          entry: { postId, revisionId, digest: contentDigest(revision), publishedAt: timestamp },
          timestamp,
        });
        changed = next !== undefined;
        return next;
      });
      if (!changed) return { ok: true, changed: false, slug: revision.slug };

      const rebuild = await api.rebuild();
      await housekeep(store);
      return { ok: true, changed: true, slug: revision.slug, ...rebuildOutcome(rebuild) };
    },

    /**
     * Every post with a stored published revision, on the site or not, and the
     * revisions it can be rolled back to, newest first.
     */
    async listPublications() {
      const [{ data: index }, objects] = await Promise.all([
        api.readIndex(),
        store.listAll("published/posts/"),
      ]);

      const stored = new Map();
      for (const object of objects) {
        const info = classifyKey(object.key);
        if (info.kind !== "published-revision") continue;
        if (!stored.has(info.postId)) stored.set(info.postId, []);
        stored.get(info.postId).push({
          revisionId: info.id,
          version: revisionVersion(info.id),
          storedAt: object.lastModified ? new Date(object.lastModified).toISOString() : null,
        });
      }

      const indexed = new Map(Object.entries(index.posts ?? {}).map(([slug, entry]) => [entry.postId, { slug, ...entry }]));
      const postIds = new Set([...indexed.keys(), ...stored.keys()]);

      const publications = await Promise.all([...postIds].map(async (postId) => {
        const revisions = (stored.get(postId) ?? []).sort((a, b) => b.revisionId.localeCompare(a.revisionId));
        const entry = indexed.get(postId);
        const lastPublished = index.unpublished?.[postId] ?? null;
        const shown = entry?.revisionId ?? lastPublished?.revisionId ?? revisions[0]?.revisionId;
        const record = shown ? await store.getJson(revisionKey(postId, shown)) : null;
        return {
          postId,
          published: Boolean(entry),
          slug: entry?.slug ?? record?.data.slug ?? null,
          title: record?.data.title ?? null,
          revisionId: entry?.revisionId ?? null,
          lastPublishedRevisionId: lastPublished?.revisionId ?? null,
          publishedAt: entry?.publishedAt ?? null,
          revisions,
        };
      }));

      const latest = (p) => p.publishedAt ?? p.revisions[0]?.storedAt ?? "";
      return publications.sort((a, b) =>
        Number(b.published) - Number(a.published) || latest(b).localeCompare(latest(a)));
    },

    /**
     * Why the most recent build failed, if it did (Step 7).
     *
     * The build writes this and deletes it when it next succeeds, so its
     * presence is the signal. Absent means either "the last build worked" or
     * "no build has run since this was added"; the editor only shows it while
     * something it is waiting for has not landed, which keeps that ambiguity
     * harmless. Never throws: a missing or corrupt record must not break the
     * publications list.
     */
    async lastBuildFailure() {
      try {
        const record = await store.getJson(keys.lastBuildFailure);
        const data = record?.data;
        if (!data?.reason || !data?.at) return null;
        return { kind: data.kind ?? "build", reason: String(data.reason), at: data.at, commit: data.commit ?? null };
      } catch {
        return null;
      }
    },
  };

  return api;
}

const rebuildOutcome = (rebuild) => rebuild.triggered
  ? { rebuilding: true }
  : { rebuilding: false, hookError: `The rebuild could not be triggered: ${rebuild.error}` };

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

/**
 * Ask Vercel to rebuild.
 *
 * Absent configuration is not an error: a preview or a local run should be able
 * to publish to its own prefix without triggering a production build.
 *
 * Calling it again while a build from the same commit is running is how builds
 * collapse: Vercel cancels the earlier deployment from the same hook, and the
 * one that finishes reads the index as it is by then.
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
