// An in-memory stand-in for the S3 client, so storage tests need no credentials
// and no network.
//
// Its conditional-write semantics are copied from what scripts/probe-r2.mjs
// actually observed against the live bucket, not from the S3 documentation:
// If-None-Match/If-Match violations reject with PreconditionFailed and HTTP 412.
// If real R2 ever diverges, the probe is what catches it — this double would
// happily keep agreeing with itself.
import crypto from "node:crypto";

const etagOf = (buf) => `"${crypto.createHash("md5").update(buf).digest("hex")}"`;

function precondition(message) {
  const err = new Error(message);
  err.name = "PreconditionFailed";
  err.$metadata = { httpStatusCode: 412 };
  return err;
}

function notFound(key) {
  const err = new Error(`No such key: ${key}`);
  err.name = "NoSuchKey";
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

function transient(name = "TimeoutError", status = 503) {
  const err = new Error(`simulated transient failure (${name})`);
  err.name = name;
  err.$metadata = { httpStatusCode: status };
  return err;
}

export function createFakeS3({ objects = new Map() } = {}) {
  // Queued one-shot failures, so retry logic can be exercised deterministically.
  const failures = [];
  let calls = 0;

  const body = (buf) => ({
    transformToByteArray: async () => new Uint8Array(buf),
    transformToString: async () => buf.toString("utf8"),
  });

  return {
    objects,
    get callCount() { return calls; },
    /** Make the next `count` sends fail with a retryable error. */
    failNext(count = 1, name = "TimeoutError") {
      for (let i = 0; i < count; i++) failures.push(transient(name));
    },

    async send(command) {
      calls++;
      if (failures.length) throw failures.shift();

      const input = command.input;
      const type = command.constructor.name;
      const key = input.Key;
      const existing = key ? objects.get(key) : undefined;

      switch (type) {
        case "PutObjectCommand": {
          if (input.IfNoneMatch === "*" && existing) {
            throw precondition(`Key already exists: ${key}`);
          }
          if (input.IfMatch !== undefined) {
            if (!existing) throw precondition(`Key does not exist: ${key}`);
            if (existing.etag !== input.IfMatch) throw precondition(`ETag mismatch on ${key}`);
          }
          const buf = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body);
          const record = {
            body: buf,
            etag: etagOf(buf),
            contentType: input.ContentType,
            cacheControl: input.CacheControl,
            lastModified: new Date(),
          };
          objects.set(key, record);
          return { ETag: record.etag };
        }

        case "GetObjectCommand": {
          if (!existing) throw notFound(key);
          return {
            Body: body(existing.body),
            ETag: existing.etag,
            ContentType: existing.contentType,
            ContentLength: existing.body.length,
          };
        }

        case "HeadObjectCommand": {
          if (!existing) throw notFound(key);
          return {
            ETag: existing.etag,
            ContentLength: existing.body.length,
            ContentType: existing.contentType,
            LastModified: existing.lastModified,
          };
        }

        case "DeleteObjectCommand": {
          objects.delete(key);
          return {};
        }

        case "CopyObjectCommand": {
          const source = decodeURIComponent(String(input.CopySource));
          // CopySource is "/<bucket>/<key>"; drop the leading slash and bucket.
          const sourceKey = source.replace(/^\//, "").split("/").slice(1).join("/");
          const from = objects.get(sourceKey);
          if (!from) throw notFound(sourceKey);
          objects.set(key, { ...from, lastModified: new Date() });
          return {};
        }

        case "ListObjectsV2Command": {
          const prefix = input.Prefix || "";
          const matching = [...objects.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .sort(([a], [b]) => a.localeCompare(b));
          const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
          const limit = input.MaxKeys ?? 1000;
          const page = matching.slice(start, start + limit);
          const next = start + limit;
          return {
            Contents: page.map(([k, v]) => ({
              Key: k, Size: v.body.length, ETag: v.etag, LastModified: v.lastModified,
            })),
            KeyCount: page.length,
            IsTruncated: next < matching.length,
            NextContinuationToken: next < matching.length ? String(next) : undefined,
          };
        }

        default:
          throw new Error(`fake-r2 does not implement ${type}`);
      }
    },
  };
}

export const FAKE_CONFIG = {
  accountId: "fake",
  bucket: "weblog-test",
  accessKeyId: "fake-key",
  secretAccessKey: "fake-secret",
  prefix: "test",
  endpoint: "https://fake.r2.cloudflarestorage.com",
};
