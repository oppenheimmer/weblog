// Private drafts, stored as immutable revisions behind a mutable pointer
// (CLAUDE.md §3.4, §4.1, Step 2).
//
// Every save writes a brand-new revision object and then moves a single pointer
// to it, conditionally. Two consequences follow, both deliberate:
//
//   * A lost pointer race leaves an orphan revision. That is harmless and
//     collectable; what must never happen is losing the previous draft.
//   * Revision history is free, because nothing is ever overwritten.
//
// Drafts are validated loosely: a half-written post with no title must still be
// saveable. Strict validation belongs at publish time, where refusing is useful.
import crypto from "node:crypto";

import { ConflictError } from "./r2.mjs";
import { FORMATS, derivePostSlug } from "../content.mjs";

export const DRAFT_SCHEMA_VERSION = 1;

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 500;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 60;
const MAX_BODY_BYTES = 1_000_000; // matches the 1 MiB expanded-source ceiling

export class DraftError extends Error {
  constructor(message, { field } = {}) {
    super(message);
    this.name = "DraftError";
    this.field = field;
    this.status = 400;
  }
}

/** Stable post identity. Opaque, but prefixed so it is recognisable in logs. */
export function newPostId() {
  return `p_${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Revision identity, ordered by the draft's version number so revisions sort
 * chronologically by key alone. Reading history is then a listing rather than a
 * fetch of every object.
 *
 * Version leads, not the timestamp. An earlier design put the timestamp first
 * and broke as soon as two saves landed in the same millisecond — the random
 * suffix decided the order, and debounced autosave produces exactly that. The
 * version is monotonic per post by construction, so it cannot tie.
 */
export function newRevisionId(version, now = Date.now()) {
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError(`revision id needs a positive integer version, got ${version}`);
  }
  return [
    "r",
    String(version).padStart(6, "0"),
    now.toString(36).padStart(9, "0"),
    crypto.randomBytes(3).toString("hex"),
  ].join("_");
}

const pointerKey = (postId) => `drafts/${postId}/current.json`;
const revisionKey = (postId, revisionId) => `drafts/${postId}/revisions/${revisionId}.json`;

function assertPostId(postId) {
  if (typeof postId !== "string" || !/^p_[0-9a-f]{16}$/.test(postId)) {
    throw new DraftError(`Invalid post id: ${JSON.stringify(postId)}`, { field: "postId" });
  }
  return postId;
}

/**
 * Normalize and bounds-check author-supplied fields.
 *
 * Deliberately permissive about *absence* and strict about *shape*: missing
 * title is fine (drafts are works in progress), a title of 10 MB is not.
 */
export function normalizeDraftInput(input = {}) {
  const out = {};

  for (const [field, max] of [["title", MAX_TITLE], ["description", MAX_DESCRIPTION]]) {
    const value = input[field];
    if (value === undefined || value === null) { out[field] = ""; continue; }
    if (typeof value !== "string") throw new DraftError(`${field} must be a string`, { field });
    if (value.length > max) throw new DraftError(`${field} exceeds ${max} characters`, { field });
    out[field] = value;
  }

  const format = input.format ?? "markdown";
  if (!FORMATS.includes(format)) {
    throw new DraftError(`format must be one of ${FORMATS.join(", ")}`, { field: "format" });
  }
  out.format = format;

  // Date stays a date-only string; the pipeline normalizes to UTC downstream.
  if (input.date === undefined || input.date === null || input.date === "") {
    out.date = "";
  } else if (typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new DraftError("date must be an ISO date (YYYY-MM-DD)", { field: "date" });
  } else {
    // Date does not reject impossible days: "2026-02-30" parses and silently
    // becomes March 2. Round-trip and compare, so a rollover is caught instead
    // of quietly changing what the author wrote.
    const parsed = new Date(`${input.date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.date) {
      throw new DraftError(`date is not a real calendar date: ${input.date}`, { field: "date" });
    }
    out.date = input.date;
  }

  const tags = input.tags ?? [];
  if (!Array.isArray(tags)) throw new DraftError("tags must be an array", { field: "tags" });
  if (tags.length > MAX_TAGS) throw new DraftError(`at most ${MAX_TAGS} tags`, { field: "tags" });
  out.tags = tags.map((tag) => {
    if (typeof tag !== "string") throw new DraftError("each tag must be a string", { field: "tags" });
    const trimmed = tag.trim();
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new DraftError(`tag exceeds ${MAX_TAG_LENGTH} characters`, { field: "tags" });
    }
    return trimmed;
  }).filter(Boolean);

  const body = input.body ?? "";
  if (typeof body !== "string") throw new DraftError("body must be a string", { field: "body" });
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new DraftError(`body exceeds ${MAX_BODY_BYTES} bytes`, { field: "body" });
  }
  out.body = body;

  // An explicit slug wins; otherwise derive from the title so the editor can
  // show the eventual URL while typing. Emptiness is allowed until publish.
  out.slug = input.slug
    ? derivePostSlug({ frontmatterSlug: input.slug })
    : derivePostSlug({ filename: out.title });

  const attachmentIds = input.attachmentIds ?? [];
  if (!Array.isArray(attachmentIds)) {
    throw new DraftError("attachmentIds must be an array", { field: "attachmentIds" });
  }
  out.attachmentIds = attachmentIds.map(String);

  return out;
}

export function createDraftStore(store, { now = () => new Date().toISOString() } = {}) {
  /** Write an immutable revision. Never overwrites: the id is unique per save. */
  async function writeRevision(postId, revision) {
    await store.createJson(revisionKey(postId, revision.revisionId), revision);
    return revision;
  }

  const api = {
    /** Create a new draft: one revision plus a pointer that must not already exist. */
    async create(input = {}) {
      const fields = normalizeDraftInput(input);
      const postId = newPostId();
      const timestamp = now();
      const revision = {
        schemaVersion: DRAFT_SCHEMA_VERSION,
        postId,
        revisionId: newRevisionId(1),
        version: 1,
        ...fields,
        publishedRevisionId: input.publishedRevisionId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await writeRevision(postId, revision);
      const { etag } = await store.createJson(pointerKey(postId), revision);
      return { draft: revision, etag };
    },

    /** Current draft plus the ETag a later save must present. Null if absent. */
    async get(postId) {
      const record = await store.getJson(pointerKey(assertPostId(postId)));
      return record ? { draft: record.data, etag: record.etag } : null;
    },

    /**
     * Save an edit. `etag` must be the one from the read this edit is based on;
     * a stale value means another tab saved first and raises ConflictError.
     */
    async save(postId, input, etag) {
      assertPostId(postId);
      if (!etag) {
        throw new DraftError("save requires the ETag from the read it is based on", { field: "etag" });
      }
      const existing = await api.get(postId);
      if (!existing) throw new DraftError(`No draft ${postId}`, { field: "postId" });

      const fields = normalizeDraftInput({ ...existing.draft, ...input });
      const nextVersion = existing.draft.version + 1;
      const revision = {
        ...existing.draft,
        ...fields,
        revisionId: newRevisionId(nextVersion),
        version: nextVersion,
        updatedAt: now(),
      };

      // Revision first, pointer second. If the pointer update loses the race the
      // new revision is orphaned, but the previous draft is untouched — which is
      // the property that matters.
      await writeRevision(postId, revision);
      const { etag: nextEtag } = await store.updateJson(pointerKey(postId), revision, etag);
      return { draft: revision, etag: nextEtag };
    },

    /** Every revision of a post, oldest first (revision ids sort by time). */
    async revisions(postId) {
      const keys = await store.listAll(`drafts/${assertPostId(postId)}/revisions/`);
      return keys
        .map((k) => k.key.split("/").pop().replace(/\.json$/, ""))
        .sort();
    },

    async getRevision(postId, revisionId) {
      const record = await store.getJson(revisionKey(assertPostId(postId), revisionId));
      return record?.data ?? null;
    },

    /** Draft summaries for the editor's list. Reads pointers only, not revisions. */
    async list({ limit = 100 } = {}) {
      const keys = await store.listAll("drafts/");
      const pointers = keys.filter((k) => k.key.endsWith("/current.json")).slice(0, limit);
      const drafts = await Promise.all(pointers.map(async ({ key }) => {
        const record = await store.getJson(key);
        if (!record) return null;
        const { body, ...summary } = record.data;
        return summary;
      }));
      return drafts
        .filter(Boolean)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    /**
     * Delete a draft and its revisions. The pointer goes first: after that the
     * draft is unreachable, so an interrupted cleanup leaves collectable
     * revisions rather than a draft pointing at objects that are gone.
     */
    async remove(postId) {
      assertPostId(postId);
      await store.delete(pointerKey(postId));
      const keys = await store.listAll(`drafts/${postId}/revisions/`);
      for (const { key } of keys) await store.delete(key);
      return keys.length;
    },
  };

  return api;
}

export { ConflictError };
