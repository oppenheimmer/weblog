// R2 object store: the only data store in this system (CLAUDE.md §3.2).
//
// The conditional-write behaviour this module depends on was verified against
// the live bucket by scripts/probe-r2.mjs before any of it was written —
// If-None-Match/If-Match are honoured, and violations come back as 412
// PreconditionFailed rather than silent overwrites.
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectCommand, ListObjectsV2Command, CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { loadR2Config } from "./config.mjs";

/** Another writer won. The caller must re-read and decide; never retry blindly. */
export class ConflictError extends Error {
  constructor(key, message = `Conflict writing ${key}: another writer won.`) {
    super(message);
    this.name = "ConflictError";
    this.key = key;
    this.status = 409;
  }
}

export class NotFoundError extends Error {
  constructor(key) {
    super(`Not found: ${key}`);
    this.name = "NotFoundError";
    this.key = key;
    this.status = 404;
  }
}

const isConflict = (err) =>
  err?.name === "PreconditionFailed" || err?.$metadata?.httpStatusCode === 412;
const isNotFound = (err) =>
  err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;

// Retry only what is genuinely transient. A 412 is a real answer, not a blip:
// retrying it would defeat the concurrency control it implements.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const isRetryable = (err) =>
  RETRYABLE_STATUS.has(err?.$metadata?.httpStatusCode) ||
  ["TimeoutError", "RequestTimeout", "NetworkingError", "ECONNRESET"].includes(err?.name);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(fn, { attempts = 3, baseDelayMs = 120 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await sleep(baseDelayMs * 2 ** i + Math.random() * baseDelayMs);
    }
  }
  throw lastError;
}

/**
 * A storage handle bound to one bucket and prefix.
 *
 * Every key passed in is relative to the prefix, so callers never build
 * environment-qualified keys by hand and cannot accidentally address another
 * environment's objects.
 */
export function createStore({ config = loadR2Config(), client } = {}) {
  const s3 = client || new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  const Bucket = config.bucket;
  const full = (key) => {
    if (typeof key !== "string" || !key.length) throw new TypeError("key must be a non-empty string");
    if (key.includes("..")) throw new TypeError(`key may not contain "..": ${key}`);
    return `${config.prefix}/${key.replace(/^\/+/, "")}`;
  };

  const send = (command) => withRetry(() => s3.send(command));

  const store = {
    config,
    client: s3,
    key: full,

    /** Raw bytes. Returns null when absent so callers need not catch. */
    async get(key) {
      try {
        const r = await send(new GetObjectCommand({ Bucket, Key: full(key) }));
        return {
          body: Buffer.from(await r.Body.transformToByteArray()),
          etag: r.ETag,
          contentType: r.ContentType,
          size: r.ContentLength,
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async head(key) {
      try {
        const r = await send(new HeadObjectCommand({ Bucket, Key: full(key) }));
        return { etag: r.ETag, size: r.ContentLength, contentType: r.ContentType, lastModified: r.LastModified };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async put(key, body, { contentType, ifMatch, ifNoneMatch, cacheControl } = {}) {
      try {
        const r = await send(new PutObjectCommand({
          Bucket, Key: full(key), Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
          IfMatch: ifMatch,
          IfNoneMatch: ifNoneMatch,
        }));
        return { etag: r.ETag };
      } catch (err) {
        if (isConflict(err)) throw new ConflictError(key);
        throw err;
      }
    },

    async delete(key) {
      await send(new DeleteObjectCommand({ Bucket, Key: full(key) }));
    },

    async copy(fromKey, toKey) {
      await send(new CopyObjectCommand({
        Bucket, Key: full(toKey), CopySource: `/${Bucket}/${full(fromKey)}`,
      }));
    },

    // ---- JSON records ------------------------------------------------------

    /** Returns `{ data, etag }`, or null when the key does not exist. */
    async getJson(key) {
      const object = await store.get(key);
      if (!object) return null;
      try {
        return { data: JSON.parse(object.body.toString("utf8")), etag: object.etag };
      } catch (err) {
        throw new Error(`Corrupt JSON at ${key}: ${err.message}`);
      }
    },

    /** Unconditional write. Prefer createJson/updateJson for mutable records. */
    putJson(key, data, options = {}) {
      return store.put(key, JSON.stringify(data, null, 2), {
        contentType: "application/json",
        ...options,
      });
    },

    /** Create only if absent. Throws ConflictError if the key already exists. */
    createJson(key, data) {
      return store.putJson(key, data, { ifNoneMatch: "*" });
    },

    /** Update only if unchanged since `etag`. Throws ConflictError on a stale read. */
    updateJson(key, data, etag) {
      if (!etag) throw new TypeError("updateJson requires the ETag from the read it is based on");
      return store.putJson(key, data, { ifMatch: etag });
    },

    /**
     * Read, transform, write — retrying only the conflict case, with a fresh
     * read each time. `mutate` receives null when the record does not yet exist
     * and may return undefined to abort without writing.
     */
    async mutateJson(key, mutate, { attempts = 5 } = {}) {
      for (let i = 0; i < attempts; i++) {
        const existing = await store.getJson(key);
        const next = await mutate(existing?.data ?? null);
        if (next === undefined) return existing?.data ?? null;
        try {
          const { etag } = existing
            ? await store.updateJson(key, next, existing.etag)
            : await store.createJson(key, next);
          return { ...next, __etag: etag };
        } catch (err) {
          if (!(err instanceof ConflictError) || i === attempts - 1) throw err;
          await sleep(40 * 2 ** i + Math.random() * 40);
        }
      }
      throw new ConflictError(key, `Gave up updating ${key} after ${attempts} conflicting attempts.`);
    },

    // ---- listing -----------------------------------------------------------

    /**
     * One page of keys. Pass the returned `cursor` back to continue.
     *
     * An empty prefix means "everything in this environment", so it cannot go
     * through the key validator, which requires a non-empty key.
     */
    async list(prefix = "", { limit = 1000, cursor } = {}) {
      if (typeof prefix !== "string") throw new TypeError("prefix must be a string");
      if (prefix.includes("..")) throw new TypeError(`prefix may not contain "..": ${prefix}`);
      const listPrefix = prefix
        ? `${config.prefix}/${prefix.replace(/^\/+/, "")}`
        : `${config.prefix}/`;
      const r = await send(new ListObjectsV2Command({
        Bucket,
        Prefix: listPrefix,
        MaxKeys: limit,
        ContinuationToken: cursor,
      }));
      const strip = `${config.prefix}/`;
      return {
        keys: (r.Contents || []).map((o) => ({
          key: o.Key.startsWith(strip) ? o.Key.slice(strip.length) : o.Key,
          size: o.Size,
          etag: o.ETag,
          lastModified: o.LastModified,
        })),
        cursor: r.IsTruncated ? r.NextContinuationToken : undefined,
      };
    },

    /** Every key under a prefix, walking pages. Use for bounded collections. */
    async listAll(prefix = "", { pageSize = 1000, max = 100_000 } = {}) {
      const all = [];
      let cursor;
      do {
        const page = await store.list(prefix, { limit: pageSize, cursor });
        all.push(...page.keys);
        cursor = page.cursor;
      } while (cursor && all.length < max);
      return all;
    },

    // ---- presigned URLs ----------------------------------------------------

    /**
     * A short-lived upload capability for one exact key and content type.
     * Treat the returned URL as a bearer token: anyone holding it can write
     * that key until it expires (CLAUDE.md Step 4).
     */
    signPut(key, { contentType, contentLength, expiresIn = 300 } = {}) {
      // Type and size are conditions of the URL itself, so storage refuses a
      // mismatched PUT before keeping a byte. Verification still identifies the
      // bytes; this bounds what a leaked URL can be used for.
      //
      // Checked rather than assumed: the presigner leaves content-type unsigned
      // unless told otherwise (SignedHeaders=host), but signs content-length
      // whenever the command carries ContentLength. So ContentLength is what
      // signs the size, and listing "content-length" below changes nothing today
      // — it is there so the guarantee does not rest on that default.
      const signed = [
        contentType && "content-type",
        Number.isInteger(contentLength) && "content-length",
      ].filter(Boolean);
      return getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket, Key: full(key), ContentType: contentType, ContentLength: contentLength }),
        { expiresIn, ...(signed.length ? { signableHeaders: new Set(signed) } : {}) }
      );
    },

    signGet(key, { expiresIn = 300 } = {}) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: full(key) }), { expiresIn });
    },
  };

  return store;
}
