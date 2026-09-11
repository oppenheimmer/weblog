// Attachment upload: sign, verify, promote (CLAUDE.md Step 4).
//
// Bytes never pass through a function. The browser PUTs straight to R2 on a
// short-lived presigned URL, because Vercel caps a function request at 4.5 MB
// and an image may be 10 MiB. What functions do is decide what may be uploaded
// before signing, and decide what actually arrived afterwards.
//
// Keys at three levels of trust:
//
//   uploads/<post>/<upload>/intent.json    what we agreed to sign   (server)
//   uploads/<post>/<upload>/file           what arrived             (browser)
//   attachments/<post>/files/<name>        what we verified         (server)
//
// The last is never signed for a browser PUT, and that is the property the
// design rests on. A presigned URL stays valid for its whole lifetime, so the
// browser — or anyone holding the URL — can PUT to the pending key again after
// verification. Promotion therefore writes the exact buffer that was identified
// and hashed, never a server-side copy of whatever the pending key holds by the
// time promotion runs.
import crypto from "node:crypto";

import { ConflictError } from "./r2.mjs";
import { keys, classifyKey } from "./keys.mjs";
import { identify, sanitizeAssetName, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_TEX_BYTES } from "../media.mjs";
import { MAX_ATTACHMENTS_PER_POST, MAX_POST_BYTES } from "../attachments.mjs";

export const ATTACHMENT_SCHEMA_VERSION = 1;
export const UPLOAD_URL_TTL_SECONDS = 300;
export const TEX_CONTENT_TYPE = "text/x-tex";

// The presigned URL covers this exact key and nothing beside it.
const UPLOAD_FILE = "file";
const POST_ID = /^p_[0-9a-f]{16}$/;
const UPLOAD_ID = /^u_[0-9a-f]{16}$/;
const ATTACHMENT_ID = /^a_[0-9a-f]{16}$/;
const MAX_NAME_ATTEMPTS = 100;

export class UploadError extends Error {
  constructor(message, { code = "upload_failed", status = 400, field } = {}) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** `diagram.png`, `diagram-2.png`, `diagram-3.png` … (§3.3: suffix, never overwrite). */
export function nthName(name, n) {
  if (n <= 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

function assertPostId(postId) {
  if (typeof postId !== "string" || !POST_ID.test(postId)) {
    throw new UploadError("Unknown post.", { code: "invalid_post", field: "postId" });
  }
}

const totalBytes = (attachments) => attachments.reduce((sum, a) => sum + (a.bytes ?? 0), 0);

export function createUploads(store, {
  signPut = (key, options) => store.signPut(key, options),
  now = () => new Date(),
} = {}) {
  /** Remove the pending slot. Best-effort: the sweep collects it after 24 hours anyway. */
  async function discard(postId, uploadId) {
    for (const key of [keys.upload(postId, uploadId, UPLOAD_FILE), keys.uploadIntent(postId, uploadId)]) {
      await store.delete(key).catch(() => {});
    }
  }

  /**
   * Claim a public name for one attachment, atomically.
   *
   * A conditional create on a per-name claim object, rather than "list, pick a
   * free name, write": two pasted screenshots are both called image.png, and a
   * check-then-write lets both see the name free. A claim already held by this
   * same attachment means an earlier attempt died after claiming, and is reused.
   */
  async function claimName(postId, attachmentId, base) {
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
      const name = nthName(base, n);
      const claimKey = keys.attachmentName(postId, name);
      try {
        await store.createJson(claimKey, { attachmentId, claimedAt: now().toISOString() });
        return name;
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        const claim = (await store.getJson(claimKey))?.data;
        if (claim?.attachmentId === attachmentId) return name;
      }
    }
    throw new UploadError("Could not find a free name for this file.", { code: "name_exhausted", status: 409 });
  }

  const api = {
    /** Every verified attachment of a post, oldest first. */
    async list(postId) {
      assertPostId(postId);
      const objects = await store.listAll(keys.attachmentPrefix(postId));
      const records = await Promise.all(objects
        .filter(({ key }) => classifyKey(key).kind === "attachment-record")
        .map(async ({ key }) => (await store.getJson(key))?.data ?? null));
      // Oldest first. Two uploads can share a millisecond, so a tie falls back to
      // the id explicitly rather than inheriting the store's listing order. S3
      // and R2 list lexicographically today, so the result is the same; the
      // point is not to depend on that.
      return records
        .filter(Boolean)
        .sort((a, b) =>
          String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    },

    /**
     * Agree to one upload and return a URL for it.
     *
     * Everything knowable in advance is checked here, so a file that would be
     * refused is never transferred. None of it is trusted afterwards: completion
     * re-derives type and size from the bytes themselves.
     */
    async sign({ postId, name, size, type, kind } = {}) {
      assertPostId(postId);
      if (!(await store.head(keys.draftPointer(postId)))) {
        throw new UploadError("Save the draft before attaching files to it.", {
          code: "not_found", status: 404, field: "postId",
        });
      }

      const isTex = kind === "tex";
      if (!Number.isInteger(size) || size < 1) {
        throw new UploadError("The file is empty, or its size is unknown.", { code: "invalid_size", field: "size" });
      }
      if (size > (isTex ? MAX_TEX_BYTES : MAX_IMAGE_BYTES)) {
        throw new UploadError(
          isTex
            ? `A .tex snippet may be at most ${MAX_TEX_BYTES / 1024} KiB.`
            : `An image may be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`,
          { code: "too_large", status: 413, field: "size" }
        );
      }

      let contentType = TEX_CONTENT_TYPE;
      if (!isTex) {
        if (!Object.values(IMAGE_TYPES).includes(type)) {
          throw new UploadError(
            "Only PNG, JPEG, GIF and WebP images can be attached. SVG, PDF and archives are not accepted.",
            { code: "unsupported_type", status: 415, field: "type" }
          );
        }
        contentType = type;
      }

      const existing = await api.list(postId);
      if (existing.length >= MAX_ATTACHMENTS_PER_POST) {
        throw new UploadError(`A post may have at most ${MAX_ATTACHMENTS_PER_POST} attachments.`, {
          code: "too_many_attachments", status: 409,
        });
      }
      if (totalBytes(existing) + size > MAX_POST_BYTES) {
        throw new UploadError(`A post's attachments may total at most ${MAX_POST_BYTES / 1024 / 1024} MiB.`, {
          code: "post_too_large", status: 413,
        });
      }

      // One random value names both the upload and the attachment it becomes,
      // so completion can find its own result without any lookup table.
      const id = crypto.randomBytes(8).toString("hex");
      const uploadId = `u_${id}`;
      const created = now();
      const intent = {
        schemaVersion: ATTACHMENT_SCHEMA_VERSION,
        postId,
        uploadId,
        attachmentId: `a_${id}`,
        kind: isTex ? "tex" : "image",
        originalName: String(name ?? "").slice(0, 255),
        declaredType: contentType,
        declaredSize: size,
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      };
      await store.createJson(keys.uploadIntent(postId, uploadId), intent);

      const url = await signPut(keys.upload(postId, uploadId, UPLOAD_FILE), {
        contentType,
        // Signed, so storage itself refuses a PUT of any other size: the pending
        // object can never be larger than what was checked above.
        contentLength: size,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      });
      return {
        uploadId,
        attachmentId: intent.attachmentId,
        url,
        method: "PUT",
        headers: { "content-type": contentType },
        expiresAt: intent.expiresAt,
      };
    },

    /**
     * Verify what arrived and promote it to an attachment.
     *
     * Idempotent: completing the same upload again returns the record the first
     * completion produced. A retry after a timeout therefore cannot create a
     * second copy under a suffixed name.
     */
    async complete({ postId, uploadId } = {}) {
      assertPostId(postId);
      if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) {
        throw new UploadError("Unknown upload.", { code: "invalid_upload", field: "uploadId" });
      }
      const attachmentId = `a_${uploadId.slice(2)}`;
      const recordKey = keys.attachmentRecord(postId, attachmentId);

      const done = await store.getJson(recordKey);
      if (done) return done.data;

      // Keyed under the post, so an upload signed for one post cannot be
      // completed into another: the intent is simply not found there.
      const intent = (await store.getJson(keys.uploadIntent(postId, uploadId)))?.data;
      if (!intent) {
        throw new UploadError("No such upload for this post, or it has expired.", {
          code: "not_found", status: 404, field: "uploadId",
        });
      }

      const pendingKey = keys.upload(postId, uploadId, UPLOAD_FILE);
      const missing = () => new UploadError("The file has not finished uploading.", {
        code: "upload_missing", status: 409, field: "uploadId",
      });

      // Size from metadata, before any read. A function must not learn that an
      // object is 5 GB by loading it into memory. The signed content-length makes
      // this unreachable on R2; checking here keeps it unreachable regardless.
      const head = await store.head(pendingKey);
      if (!head) throw missing();
      const limit = intent.kind === "tex" ? MAX_TEX_BYTES : MAX_IMAGE_BYTES;
      if (head.size > limit || head.size !== intent.declaredSize) {
        await discard(postId, uploadId);
        throw head.size > limit
          ? new UploadError("The uploaded file is larger than an attachment may be.", {
            code: "too_large", status: 413, field: "file",
          })
          : new UploadError("The uploaded file is not the size agreed when it was signed.", {
            code: "size_mismatch", status: 422, field: "file",
          });
      }

      const pending = await store.get(pendingKey);
      if (!pending) throw missing();

      // Read exactly once. These bytes are identified, hashed and promoted, and
      // nothing is read from the pending key again.
      const bytes = pending.body;
      if (bytes.length !== intent.declaredSize) {
        await discard(postId, uploadId);
        throw new UploadError("The uploaded file is not the size agreed when it was signed.", {
          code: "size_mismatch", status: 422, field: "file",
        });
      }
      const found = identify(bytes, { kind: intent.kind });
      if (!found.ok) {
        await discard(postId, uploadId);
        throw new UploadError(found.reason, { code: "rejected", status: 422, field: "file" });
      }

      const existing = await api.list(postId);
      if (existing.length >= MAX_ATTACHMENTS_PER_POST) {
        await discard(postId, uploadId);
        throw new UploadError(`A post may have at most ${MAX_ATTACHMENTS_PER_POST} attachments.`, {
          code: "too_many_attachments", status: 409,
        });
      }
      if (totalBytes(existing) + bytes.length > MAX_POST_BYTES) {
        await discard(postId, uploadId);
        throw new UploadError(`A post's attachments may total at most ${MAX_POST_BYTES / 1024 / 1024} MiB.`, {
          code: "post_too_large", status: 413,
        });
      }

      const publicName = await claimName(
        postId, attachmentId, sanitizeAssetName(intent.originalName, found.extension)
      );
      // Only this attachment holds the claim, so an unconditional write is safe;
      // a retry rewrites the same verified bytes.
      await store.put(keys.attachmentBlob(postId, publicName), bytes, { contentType: found.mediaType });

      const record = {
        schemaVersion: ATTACHMENT_SCHEMA_VERSION,
        id: attachmentId,
        postId,
        uploadId,
        kind: found.kind,
        originalName: intent.originalName,
        publicName,
        mediaType: found.mediaType,
        bytes: bytes.length,
        sha256: sha256(bytes),
        ...(found.kind === "image" ? { width: found.width, height: found.height } : {}),
        key: keys.attachmentBlob(postId, publicName),
        status: "verified",
        createdAt: now().toISOString(),
      };

      try {
        await store.createJson(recordKey, record);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        // A concurrent completion of this same upload got there first. It
        // claimed the same name and wrote the same bytes, so its record stands.
        return (await store.getJson(recordKey))?.data ?? record;
      }

      await discard(postId, uploadId);
      return record;
    },

    /**
     * Remove an attachment from a draft.
     *
     * The published copy is separate (published/media/), so a live page keeps
     * its image. The name claim stays behind as a tombstone: a later upload can
     * never take this name and change what an existing public URL shows.
     */
    async remove(postId, attachmentId) {
      assertPostId(postId);
      if (typeof attachmentId !== "string" || !ATTACHMENT_ID.test(attachmentId)) {
        throw new UploadError("Unknown attachment.", { code: "invalid_attachment", field: "attachmentId" });
      }
      const recordKey = keys.attachmentRecord(postId, attachmentId);
      const record = (await store.getJson(recordKey))?.data;
      if (!record) return { removed: false };
      // Record first: once it is gone nothing resolves to the file, so an
      // interrupted removal leaves an unreferenced file, not a dangling record.
      await store.delete(recordKey);
      await store.delete(keys.attachmentBlob(postId, record.publicName));
      return { removed: true };
    },

    /**
     * Text of every `.tex` attachment of a post.
     *
     * All of them rather than only those a body names directly, because a
     * snippet may include another snippet the body never mentions.
     */
    async snippetTexts(postId, attachments) {
      const texts = new Map();
      for (const attachment of attachments) {
        if (attachment.kind !== "tex" || attachment.postId !== postId) continue;
        const object = await store.get(keys.attachmentBlob(postId, attachment.publicName));
        if (object) texts.set(attachment.id, object.body.toString("utf8"));
      }
      return texts;
    },
  };

  return api;
}
