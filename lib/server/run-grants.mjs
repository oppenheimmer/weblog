// Run interactive preview: an unpublished bundle, served where it can run
// (CLAUDE.md §3.6).
//
// A lab reads `./demo.mjs` and a figure imports `./helper.mjs`, so a bundle
// only runs from a directory URL its relative paths resolve inside. Its bytes
// sit in private storage, and a signed storage URL cannot provide that: the
// signature belongs to one object, and the relative request beside it carries
// none. So the preview function serves them itself, at
//
//   /api/preview/run/<grant>/<relative name>
//
// **The grant is the whole of the permission.** A run frame is sandboxed
// without its own origin (assets/editor.js), and a sandboxed document's
// requests carry no session cookie, so a session cannot authorize them. The
// grant is an HMAC over one verified revision of one interactive and an
// expiry, so it reads one unpublished bundle for half an hour and nothing
// else — the same kind of short-lived bearer capability a preview's signed
// image URL already is.
//
// Every response is the published lab path's policy again: sandboxed if
// opened directly, readable by the opaque origin that imports it, never cached.
import crypto from "node:crypto";

import { keys } from "./keys.mjs";
import { normalizeBundlePath, extensionOf, InteractiveError } from "../interactives.mjs";

export const RUN_PREFIX = "/api/preview/run/";
export const RUN_GRANT_TTL_SECONDS = 30 * 60;
// Under Vercel's 4.5 MB response cap, which a bundle file (up to 5 MiB) can exceed.
export const MAX_RUN_FILE_BYTES = 4_000_000;

const GRANT = /^(p_[0-9a-f]{16})\.(i_[0-9a-f]{16})\.(iv_[0-9a-f]{16})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/;

// Domain-separated from the rate limiter's uses of the same secret.
const grantKey = (secret) => {
  if (!secret) throw new Error("RATE_LIMIT_HASH_SECRET is required to run interactives in preview");
  return crypto.createHmac("sha256", secret).update("weblog preview run grant v1").digest();
};
const mac = (body, secret) => crypto.createHmac("sha256", grantKey(secret)).update(body).digest("base64url");

/** A grant to read one verified revision of one interactive until it expires. */
export function mintRunGrant({ postId, interactiveId, revisionId }, {
  secret, now = Date.now(), ttlSeconds = RUN_GRANT_TTL_SECONDS,
} = {}) {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const body = `${postId}.${interactiveId}.${revisionId}.${expires.toString(36)}`;
  const grant = `${body}.${mac(body, secret)}`;
  if (!GRANT.test(grant)) throw new Error("a run grant was minted for ids of the wrong shape");
  return grant;
}

/** What a grant permits, or null for one that is malformed, forged or expired. */
export function readRunGrant(grant, { secret, now = Date.now() } = {}) {
  const match = GRANT.exec(String(grant ?? ""));
  if (!match || !secret) return null;
  const [, postId, interactiveId, revisionId, expires, presented] = match;
  const expected = Buffer.from(mac(`${postId}.${interactiveId}.${revisionId}.${expires}`, secret));
  const given = Buffer.from(presented);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (parseInt(expires, 36) * 1000 <= now) return null;
  return { postId, interactiveId, revisionId };
}

/** The directory a granted bundle runs from; its entry is served at the directory itself. */
export const runDirectory = (grant) => `${RUN_PREFIX}${grant}/`;

/**
 * Where a run request points: `{ grant, file }`.
 *
 * Read from the query a `vercel.json` rewrite supplies, or from the path when
 * the platform hands the function the address as requested — whichever
 * arrives, so neither is a guess about which one Vercel does.
 */
export function runTarget(req) {
  const url = new URL(String(req.url ?? "/"), "http://local");
  const query = req.query ?? Object.fromEntries(url.searchParams);
  if (typeof query.grant === "string" && query.grant) {
    return { grant: query.grant, file: typeof query.file === "string" ? query.file : "" };
  }
  const match = /^\/api\/preview\/run\/([^/]+)\/(.*)$/.exec(url.pathname);
  if (!match) return null;
  try {
    return { grant: match[1], file: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

export const RUN_HEADERS = {
  // Opened directly, the file is still a sandboxed document with no origin
  // of its own: the /demos/ rule, applied here because no header rule reaches
  // a function's response.
  "content-security-policy": "sandbox allow-scripts",
  // The run frame has an opaque origin, and module imports and a bundle's own
  // data reads are CORS requests from it. What can be read is one granted
  // revision of an unpublished bundle, which the grant already hands over.
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

const miss = (status = 404) => ({ status });

/**
 * Read one file of a granted bundle, or say why not.
 *
 * Only what the verified manifest declares. HTML only as a lab's entry, and
 * only at the directory: a lab's own relative paths need the entry *at* that
 * address, `cleanUrls` redirects a request ending in `.html`, and a fallback
 * is inlined into the page rather than ever navigated to.
 */
export function createRunFiles(store) {
  return {
    async read({ postId, interactiveId, revisionId }, file = "") {
      const record = (await store.getJson(keys.interactiveManifest(postId, interactiveId, revisionId)))?.data;
      if (record?.status !== "verified" || record.postId !== postId) return miss();

      let name;
      if (file === "") {
        if (record.kind !== "demo") return miss();
        name = record.entry;
      } else {
        try {
          name = normalizeBundlePath(file);
        } catch (err) {
          if (err instanceof InteractiveError) return miss();
          throw err;
        }
        if (extensionOf(name) === ".html") return miss();
      }

      const declared = record.files.find((entry) => entry.name === name);
      if (!declared) return miss();
      if (declared.bytes > MAX_RUN_FILE_BYTES) return miss(413);
      const object = await store.get(keys.interactiveFile(postId, interactiveId, revisionId, name));
      if (!object) return miss();
      return { status: 200, type: declared.type, body: object.body };
    },
  };
}
