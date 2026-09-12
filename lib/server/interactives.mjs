// Bundle upload: agree, transfer, verify, promote (CLAUDE.md §3.6, Slice 6C).
//
// The same shape as attachment upload (Step 4), for the same reason: bytes do
// not pass through a function, so the browser — or the staging push — PUTs
// straight to R2 on short-lived presigned URLs, and what a function does is
// decide what may be uploaded beforehand and what actually arrived afterwards.
//
// Keys at three levels of trust, exactly as uploads.mjs has them:
//
//   uploads/<post>/<upload>/manifest.json     what we agreed to  (server)
//   uploads/<post>/<upload>/files/<name>      what arrived       (browser)
//   interactives/<post>/<id>/<rev>/files/…    what we verified   (server)
//
// The last is never signed, so a presigned URL that is still valid cannot
// replace a file after it has been checked. A bundle is many files rather than
// one, which adds a rule attachments did not need:
//
//   **manifest.json is the commit point.** Files are promoted first and the
//   manifest last, so a bundle either exists whole or does not exist. A
//   revision whose files are present but whose manifest is not is an
//   interrupted upload, and the collector sweeps it on the pending-upload
//   window rather than leaving it forever.
import crypto from "node:crypto";

import { ConflictError } from "./r2.mjs";
import { keys, classifyKey } from "./keys.mjs";
import {
  validateManifest, computeRevisionId, InteractiveError,
  INTERACTIVE_ID_PATTERN, INTERACTIVE_REVISION_PATTERN, LIMITS,
} from "../interactives.mjs";

export const INTERACTIVE_RECORD_VERSION = 1;
export const BUNDLE_URL_TTL_SECONDS = 900; // a folder takes longer than one file

const POST_ID = /^p_[0-9a-f]{16}$/;
const UPLOAD_ID = /^u_[0-9a-f]{16}$/;
const MAX_NAME_ATTEMPTS = 100;

export class BundleError extends Error {
  constructor(message, { code = "bundle_failed", status = 400, field } = {}) {
    super(message);
    this.name = "BundleError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** `orbit`, `orbit-2`, `orbit-3` … — the same suffix rule public media names use. */
export function nthBundleName(name, n) {
  return n <= 1 ? name : `${name}-${n}`;
}

function assertPostId(postId) {
  if (typeof postId !== "string" || !POST_ID.test(postId)) {
    throw new BundleError("Unknown post.", { code: "invalid_post", field: "postId" });
  }
}

/** Turn a contract refusal into the shape routes and the editor already handle. */
function asBundleError(err) {
  if (err instanceof InteractiveError) {
    return new BundleError(err.message, { code: err.code, status: 422, field: err.field });
  }
  return err;
}

export function createInteractives(store, {
  signPut = (key, options) => store.signPut(key, options),
  now = () => new Date(),
} = {}) {
  const pendingPrefix = (postId, uploadId) => keys.upload(postId, uploadId, "files/");

  /**
   * Drop what an upload no longer needs.
   *
   * `keepReceipt` leaves the intent object behind, and that is what makes
   * completion idempotent. The intent is the only thing that maps an upload id
   * back to the bundle it became — attachments can derive one id from the
   * other, a bundle's ids are independent — so deleting it on success turned a
   * repeated completion into "no such upload". The transferred files, which are
   * the bulk, go immediately either way; the receipt is a few hundred bytes and
   * the collector sweeps it on the pending-upload window.
   */
  async function discard(postId, uploadId, { keepReceipt = false } = {}) {
    const receipt = keys.upload(postId, uploadId, "manifest.json");
    for (const { key } of await store.listAll(keys.upload(postId, uploadId, ""))) {
      if (keepReceipt && key === receipt) continue;
      await store.delete(key).catch(() => {});
    }
  }

  /**
   * Claim a public name for one bundle, atomically.
   *
   * A conditional create, not "list, pick a free name, write" — the same race
   * two pasted screenshots create for attachments. A claim this interactive
   * already holds is reused, which is what keeps a bundle's public path stable
   * across its revisions: the name belongs to the interactive, not the revision.
   */
  async function claimName(postId, interactiveId, base) {
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
      const name = nthBundleName(base, n);
      const claimKey = keys.interactiveName(postId, name);
      try {
        await store.createJson(claimKey, { interactiveId, claimedAt: now().toISOString() });
        return name;
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        const claim = (await store.getJson(claimKey))?.data;
        if (claim?.interactiveId === interactiveId) return name;
      }
    }
    throw new BundleError("Could not find a free name for this interactive.", {
      code: "name_exhausted", status: 409,
    });
  }

  /** The name this interactive already answers to, if it has one. */
  async function nameOf(postId, interactiveId) {
    for (const { key } of await store.listAll(`interactives/${postId}/names/`)) {
      const claim = (await store.getJson(key))?.data;
      if (claim?.interactiveId === interactiveId) {
        return classifyKey(key).name;
      }
    }
    return null;
  }

  const api = {
    /** Every verified bundle of a post, oldest first. */
    async list(postId) {
      assertPostId(postId);
      const objects = await store.listAll(keys.interactivePrefix(postId));
      const records = await Promise.all(objects
        .filter(({ key }) => classifyKey(key).kind === "interactive-manifest")
        .map(async ({ key }) => (await store.getJson(key))?.data ?? null));
      return records
        .filter((record) => record?.status === "verified")
        .sort((a, b) =>
          String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    },

    /** One bundle by id: its newest verified revision. */
    async get(postId, interactiveId) {
      const all = await api.list(postId);
      const mine = all.filter((record) => record.id === interactiveId);
      return mine.length ? mine[mine.length - 1] : null;
    },

    /**
     * Agree to a bundle and return a URL for each of its files.
     *
     * Everything knowable before the bytes move is decided here — the contract,
     * the per-post limit, the revision the manifest implies. None of it is
     * trusted afterwards: completion rehashes every byte that arrives.
     */
    async begin({ postId, manifest, interactiveId } = {}) {
      assertPostId(postId);
      if (!(await store.head(keys.draftPointer(postId)))) {
        throw new BundleError("Save the draft before attaching an interactive to it.", {
          code: "not_found", status: 404, field: "postId",
        });
      }

      let validated;
      try {
        validated = validateManifest(manifest, { postId });
      } catch (err) {
        throw asBundleError(err);
      }

      if (interactiveId !== undefined && !INTERACTIVE_ID_PATTERN.test(String(interactiveId))) {
        throw new BundleError("Unknown interactive.", { code: "invalid_interactive", field: "interactiveId" });
      }
      const id = interactiveId ?? `i_${crypto.randomBytes(8).toString("hex")}`;
      const revisionId = computeRevisionId(validated);

      // Re-pushing an unchanged folder lands on the revision already stored.
      // The revision id is the bundle's contents, so "already there" is a fact
      // about the bytes rather than a guess, and nothing is transferred again.
      const existing = (await store.getJson(keys.interactiveManifest(postId, id, revisionId)))?.data;
      if (existing?.status === "verified") {
        return { interactiveId: id, revisionId, unchanged: true, uploads: [], record: existing };
      }

      const bundles = await api.list(postId);
      const distinct = new Set(bundles.map((record) => record.id));
      if (!distinct.has(id) && distinct.size >= LIMITS.perPost) {
        throw new BundleError(`A post may have at most ${LIMITS.perPost} interactives.`, {
          code: "too_many_interactives", status: 409,
        });
      }

      const uploadId = `u_${crypto.randomBytes(8).toString("hex")}`;
      const created = now();
      const intent = {
        schemaVersion: INTERACTIVE_RECORD_VERSION,
        postId,
        uploadId,
        interactiveId: id,
        revisionId,
        manifest: validated,
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + BUNDLE_URL_TTL_SECONDS * 1000).toISOString(),
      };
      await store.putJson(keys.upload(postId, uploadId, "manifest.json"), intent);

      const uploads = await Promise.all(validated.files.map(async (file) => ({
        name: file.name,
        url: await signPut(`${pendingPrefix(postId, uploadId)}${file.name}`, {
          contentType: file.type,
          // Signed, so storage itself refuses a PUT of any other size.
          contentLength: file.bytes,
          expiresIn: BUNDLE_URL_TTL_SECONDS,
        }),
        method: "PUT",
        headers: { "content-type": file.type },
      })));

      return {
        interactiveId: id,
        revisionId,
        uploadId,
        unchanged: false,
        uploads,
        expiresAt: intent.expiresAt,
      };
    },

    /**
     * Verify every file that arrived, then promote the bundle.
     *
     * Idempotent: completing again returns the record the first completion
     * produced, because the manifest is written once and read first.
     */
    async complete({ postId, uploadId } = {}) {
      assertPostId(postId);
      if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) {
        throw new BundleError("Unknown upload.", { code: "invalid_upload", field: "uploadId" });
      }

      // Keyed under the post, so an upload signed for one post cannot be
      // completed into another: the intent is simply not there.
      const intent = (await store.getJson(keys.upload(postId, uploadId, "manifest.json")))?.data;
      if (!intent) {
        throw new BundleError("No such upload for this post, or it has expired.", {
          code: "not_found", status: 404, field: "uploadId",
        });
      }
      const { interactiveId, revisionId, manifest } = intent;

      const recordKey = keys.interactiveManifest(postId, interactiveId, revisionId);
      const done = (await store.getJson(recordKey))?.data;
      if (done?.status === "verified") {
        await discard(postId, uploadId, { keepReceipt: true });
        return done;
      }

      // Everything is checked before anything is promoted, so a bundle that
      // fails verification leaves no half of itself behind under a key the
      // published path can reach.
      const verified = [];
      for (const file of manifest.files) {
        const pendingKey = `${pendingPrefix(postId, uploadId)}${file.name}`;

        // Size from metadata before any read: a function must not learn an
        // object is enormous by loading it.
        const head = await store.head(pendingKey);
        if (!head) {
          throw new BundleError(`"${file.name}" has not finished uploading.`, {
            code: "upload_missing", status: 409, field: "files",
          });
        }
        if (head.size !== file.bytes) {
          throw new BundleError(`"${file.name}" is not the size agreed when it was signed.`, {
            code: "size_mismatch", status: 422, field: "files",
          });
        }

        const pending = await store.get(pendingKey);
        if (!pending) {
          throw new BundleError(`"${file.name}" has not finished uploading.`, {
            code: "upload_missing", status: 409, field: "files",
          });
        }
        const bytes = pending.body;
        // The declared hash is what the revision id was derived from, so a file
        // whose bytes disagree with it would be published under an id that
        // describes different content. Recomputed here, never taken on trust.
        const actual = sha256(bytes);
        if (actual !== file.sha256) {
          throw new BundleError(`"${file.name}" is not the file that was declared.`, {
            code: "hash_mismatch", status: 422, field: "files",
          });
        }
        verified.push({ file, bytes });
      }

      const base = await nameOf(postId, interactiveId);
      const name = base ?? await claimName(postId, interactiveId, manifest.name);

      for (const { file, bytes } of verified) {
        await store.put(
          keys.interactiveFile(postId, interactiveId, revisionId, file.name),
          bytes,
          { contentType: file.type }
        );
      }

      const record = {
        ...manifest,
        schemaVersion: INTERACTIVE_RECORD_VERSION,
        id: interactiveId,
        postId,
        revisionId,
        name,
        status: "verified",
        createdAt: now().toISOString(),
      };

      // Last, and the commit point: a bundle is verified exactly when its
      // manifest exists. Anything that dies before this leaves files the
      // collector sweeps, never a bundle publication could resolve.
      try {
        await store.createJson(recordKey, record);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        const winner = (await store.getJson(recordKey))?.data;
        if (winner) {
          await discard(postId, uploadId, { keepReceipt: true });
          return winner;
        }
        throw err;
      }

      await discard(postId, uploadId, { keepReceipt: true });
      return record;
    },

    /**
     * The fallback HTML of every verified bundle of a post.
     *
     * All of them rather than only those a body names, for the same reason
     * `snippetTexts` reads every snippet: deciding which are needed is the
     * resolver's job, and it has not run yet.
     */
    async fallbackTexts(postId, records) {
      const texts = new Map();
      for (const record of records ?? await api.list(postId)) {
        if (record.postId !== postId) continue;
        const object = await store.get(
          keys.interactiveFile(postId, record.id, record.revisionId, record.fallback)
        );
        if (object) texts.set(record.id, object.body.toString("utf8"));
      }
      return texts;
    },

    /**
     * Remove an interactive from a draft.
     *
     * Every revision of it, because a bundle's revisions are its history and
     * nothing else refers to them. The published copies are separate, so a live
     * page keeps working. The name claim stays as a tombstone: a later bundle
     * can never take this name and change what a published URL shows.
     */
    async remove(postId, interactiveId) {
      assertPostId(postId);
      if (typeof interactiveId !== "string" || !INTERACTIVE_ID_PATTERN.test(interactiveId)) {
        throw new BundleError("Unknown interactive.", {
          code: "invalid_interactive", field: "interactiveId",
        });
      }
      const prefix = `${keys.interactivePrefix(postId)}${interactiveId}/`;
      const objects = await store.listAll(prefix);
      if (!objects.length) return { removed: false };

      // Manifests first: once they are gone nothing resolves to the files, so
      // an interrupted removal leaves unreferenced files rather than a bundle
      // that claims to exist and does not.
      const manifests = objects.filter(({ key }) => classifyKey(key).kind === "interactive-manifest");
      for (const { key } of manifests) await store.delete(key);
      for (const { key } of objects) {
        if (!manifests.some((m) => m.key === key)) await store.delete(key);
      }
      return { removed: true, revisions: manifests.length };
    },
  };

  return api;
}

/** Shape check for a revision id arriving from outside. */
export const isInteractiveRevision = (value) =>
  typeof value === "string" && INTERACTIVE_REVISION_PATTERN.test(value);
