import crypto from "node:crypto";
import { createDraftStore, DraftError, assertRevisionId, ConflictError } from "./drafts.mjs";
import { createUploads } from "./uploads.mjs";
import { createInteractives } from "./interactives.mjs";
import { keys } from "./keys.mjs";
import { ATTACHMENT_ID_PATTERN } from "../attachments.mjs";
import { INTERACTIVE_ID_PATTERN, INTERACTIVE_REVISION_PATTERN, normalizeBundlePath } from "../interactives.mjs";
import { sourceDocument, EXPORT_CHUNK_BYTES, MAX_EXPORT_BYTES } from "../../assets/export.mjs";

const fail = (message, status = 409) => { throw new DraftError(message, { status, code: "export_unavailable" }); };
const validName = (name) => typeof name === "string" && /^[a-z0-9][a-z0-9-]*\.(png|jpg|gif|webp|tex)$/.test(name);
const encode = (ref) => Buffer.from(JSON.stringify(ref)).toString("base64url");
const safePath = (name) => {
  try { return normalizeBundlePath(name); } catch { fail("Invalid export path.", 400); }
};

async function published(store, postId, revisionId) {
  assertRevisionId(revisionId);
  const record = (await store.getJson(keys.publishedRevision(postId, revisionId)))?.data;
  if (!record || record.postId !== postId) fail("The inherited publication is no longer retained.", 404);
  return record;
}

/** Every locator is resolved through an owned verified manifest, never as a raw object key. */
async function fileDescriptor(store, postId, ref) {
  let file, key;
  if (ref.type === "attachment") {
    if (!ATTACHMENT_ID_PATTERN.test(ref.id)) fail("Invalid attachment.", 400);
    file = (await store.getJson(keys.attachmentRecord(postId, ref.id)))?.data;
    if (!file || file.postId !== postId || file.status !== "verified" || !validName(file.publicName)) fail("An attachment is no longer available.", 404);
    key = keys.attachmentBlob(postId, file.publicName);
  } else if (ref.type === "bundle") {
    if (!INTERACTIVE_ID_PATTERN.test(ref.id) || !INTERACTIVE_REVISION_PATTERN.test(ref.revision)) fail("Invalid interactive.", 400);
    const bundle = (await store.getJson(keys.interactiveManifest(postId, ref.id, ref.revision)))?.data;
    if (!bundle || bundle.postId !== postId || bundle.status !== "verified") fail("An interactive is no longer available.", 404);
    const name = safePath(ref.name);
    file = bundle.files.find((f) => f.name === name);
    key = keys.interactiveFile(postId, ref.id, ref.revision, name);
  } else if (ref.type === "published-image" || ref.type === "published-bundle") {
    const revision = await published(store, postId, ref.publication);
    if (ref.type === "published-image") {
      if (!validName(ref.name)) fail("Invalid image.", 400);
      file = revision.media?.find((f) => f.publicName === ref.name);
      key = keys.media(postId, ref.name);
    } else {
      const bundle = revision.interactives?.find((b) => b.id === ref.id && b.revisionId === ref.revision);
      const name = safePath(ref.name);
      file = bundle?.files.find((f) => f.name === name);
      key = keys.publishedInteractive(postId, ref.id, ref.revision, name);
    }
  } else fail("Invalid export file.", 400);
  if (!file || !Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > 10 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
    fail("An export file has invalid verification metadata.");
  }
  return { key, bytes: file.bytes, sha256: file.sha256 };
}

export async function postExportManifest(store, postId, { etag } = {}) {
  const found = await createDraftStore(store).get(postId);
  if (!found) fail("Save this draft before exporting a complete package.", 404);
  if (etag && etag !== found.etag) throw new ConflictError(postId, "This draft changed elsewhere. Reopen it before exporting a complete post; Export source preserves the text on screen.");
  const draft = found.draft;
  const attachments = await createUploads(store).list(postId);
  const all = await createInteractives(store).list(postId);
  const bundles = [...new Map(all.map((b) => [b.id, b])).values()];
  const files = [], references = [], virtual = [], paths = new Map();
  async function add(path, ref) {
    const descriptor = await fileDescriptor(store, postId, ref);
    if (paths.has(path)) {
      if (paths.get(path) !== descriptor.sha256) fail("Conflicting export filenames.");
      return;
    }
    paths.set(path, descriptor.sha256);
    files.push({ path, bytes: descriptor.bytes, sha256: descriptor.sha256, token: encode(ref) });
  }
  for (const a of attachments.filter((a) => a.status === "verified")) {
    const path = `${a.kind === "tex" ? "snippets" : "images"}/${a.publicName}`;
    await add(path, { type: "attachment", id: a.id });
    references.push({ reference: `attachment://${a.id}`, id: a.id, kind: a.kind, path });
  }
  async function addBundle(bundle, publication = null) {
    const base = `interactives/${bundle.kind}-${bundle.name}/${bundle.revisionId}`;
    // The same path validator used at upload rejects unsafe metadata before any archive is made.
    normalizeBundlePath(bundle.name);
    for (const file of bundle.files) await add(`${base}/${normalizeBundlePath(file.name)}`, {
      type: publication ? "published-bundle" : "bundle", id: bundle.id, revision: bundle.revisionId,
      name: file.name, ...(publication ? { publication } : {}),
    });
    references.push({ reference: `::${bundle.kind}[${bundle.id}]`, kind: bundle.kind, path: base, revisionId: bundle.revisionId,
      entry: bundle.entry, fallback: bundle.fallback, dependencies: bundle.dependencies ?? [] });
  }
  for (const bundle of bundles) await addBundle(bundle);
  if (draft.publishedRevisionId) {
    const inherited = await published(store, postId, draft.publishedRevisionId);
    for (const image of inherited.media ?? []) {
      const path = `published/images/${image.publicName}`;
      await add(path, { type: "published-image", publication: draft.publishedRevisionId, name: image.publicName });
      references.push({ reference: `/images/uploads/${inherited.slug}/${image.publicName}`, path });
    }
    for (const bundle of inherited.interactives ?? []) await addBundle(bundle, draft.publishedRevisionId);
  }
  if (files.length > 1100 || files.reduce((n, f) => n + f.bytes, 0) > MAX_EXPORT_BYTES - 2_000_000) fail("This post exceeds the export size limit.", 413);
  const extension = draft.format === "latex" ? "tex" : "md";
  virtual.push({ path: `post.${extension}`, text: sourceDocument(draft) });
  const manifest = { schemaVersion: 1, version: draft.version, format: draft.format, references,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  virtual.push({ path: "manifest.json", text: JSON.stringify(manifest, null, 2) + "\n" });
  virtual.push({ path: "README.txt", text: [
    "Complete post export", "", "post.md/post.tex preserves the saved authoring source and metadata.",
    "manifest.json maps attachment ids, snippet ids and interactive directives to local files/folders.",
    "Current verified attachments (including unused ones), current bundles and inherited publication assets are included.",
    "Bundle relative paths are preserved. The manifest records entry, fallback and dependencies.",
    "Engine directives require the blog renderer; this ZIP is a portable copy, not an archive import format.",
    "Draft and bundle history, sessions and publication jobs require a full bucket backup.", "",
  ].join("\n") });
  return { version: draft.version, filename: `${draft.slug || "draft"}-v${draft.version}.zip`, files, virtual };
}

export async function exportFileChunk(store, postId, token, offset = 0) {
  // Validate the post through the existing storage contract even for a forged locator.
  if (!(await createDraftStore(store).get(postId))) fail("No such draft.", 404);
  if (typeof token !== "string" || token.length > 2048) fail("Invalid export file.", 400);
  let ref;
  try { ref = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { fail("Invalid export file.", 400); }
  if (!ref || typeof ref !== "object") fail("Invalid export file.", 400);
  const descriptor = await fileDescriptor(store, postId, ref);
  if (!Number.isInteger(offset) || offset < 0 || offset % EXPORT_CHUNK_BYTES !== 0 || offset >= Math.max(1, descriptor.bytes)) fail("Invalid export offset.", 400);
  const head = await store.head(descriptor.key);
  if (!head || head.size !== descriptor.bytes) fail("An export file is missing or has changed.");
  const object = await store.get(descriptor.key);
  if (!object || object.body.length !== descriptor.bytes || crypto.createHash("sha256").update(object.body).digest("hex") !== descriptor.sha256) fail("An export file failed byte verification.");
  return object.body.subarray(offset, Math.min(offset + EXPORT_CHUNK_BYTES, descriptor.bytes));
}
