// The staging push: a post folder on disk to a published post, and then gone
// (CLAUDE.md §3.6, Slice 6E).
//
// A post written on a desktop — its Markdown and the interactive folders it
// names — reaches R2 through exactly the services the editor uses: drafts,
// bundle upload on signed URLs, and `publish.mjs`. It is a second front end to
// one publication service, not a side uploader, so validation, slug conflicts,
// idempotency, ownership and the post-publish sweep all apply unchanged.
//
// Staging is a spool, not a store. Gitignored is not absent: a lab left in the
// working tree is data inside the engine, one `git add -f` from being public.
// Three rules follow, and the order of the code is the order of the rules:
//
//   1. **Every file is accounted for before anything is written.** A file the
//      push would not send is a file it would leave behind, so it is refused up
//      front, along with links, which it neither follows nor deletes through.
//   2. **Nothing is deleted until the post is published, and then only what R2
//      is read back to hold.** A file whose bytes on disk differ from what the
//      published revision serves stays, and so does the rest of its folder.
//   3. **The source goes last.** It is what a re-run reads, so while it exists an
//      interrupted push is finished by running the push again.
//
// A staged post:
//
//   staging/<anything>/
//     post.md                  exactly one .md, .markdown or .tex
//     double-pendulum/         one folder per ::demo[double-pendulum]
//       interactive.json       optional: entry, fallback, dependencies
//       index.html  fallback.html  demo.mjs  …
//
// A folder is named in the post by its own name, and the push writes the
// interactive's id in its place, so the draft saved to R2 reads exactly as one
// written in the editor. Code examples are never rewritten.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { keys, POST_ID_PATTERN } from "./keys.mjs";
import { createDraftStore, normalizeDraftInput, DraftError } from "./drafts.mjs";
import { createInteractives, nthBundleName } from "./interactives.mjs";
import { createPublisher, validateForPublish, PublishError } from "./publish.mjs";
import { parseSource } from "../content.mjs";
import { replaceOutsideCode } from "../attachments.mjs";
import {
  validateManifest, computeRevisionId, validateFallback, findInteractiveReferences,
  sanitizeInteractiveName, isInteractiveId, InteractiveError,
} from "../interactives.mjs";

/** The one file in a bundle folder that is the push's, not the bundle's. */
export const BUNDLE_CONFIG = "interactive.json";
export const DEFAULT_ENTRY = { demo: "index.html", figure: "main.mjs" };
export const DEFAULT_FALLBACK = "fallback.html";

const SOURCE_FORMATS = { ".md": "markdown", ".markdown": "markdown", ".tex": "latex" };

// The author-facing fields the editor's import admits, and no others. Engine
// hooks — scripts, styles, head, distill — are refused rather than ignored: a
// push that silently dropped them would publish a post its author did not write.
const FRONTMATTER_FIELDS = ["title", "date", "slug", "description", "tags", "format"];
const CONFIG_FIELDS = ["kind", "entry", "fallback", "dependencies"];
const CONTENT_FIELDS = ["title", "date", "slug", "description", "format", "body"];

// A folder reference is one directory beside the post, spelled so that it
// cannot mean anything else: no separators, no leading dot, no traversal.
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIRECTIVE = /::(demo|figure)\[([^\]]*)\]/g;

// `validateManifest` needs an owner, and the real one is not known until the
// post is found. Ownership is decided again, for real, when the bundle begins.
const PLACEHOLDER_POST = "p_0000000000000000";
const MAX_NAME_CLAIMS = 100;

export class StagingError extends Error {
  constructor(message, { code = "staging_refused", path: file } = {}) {
    super(message);
    this.name = "StagingError";
    this.code = code;
    this.path = file;
  }
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const slash = (from, to) => path.relative(from, to).split(path.sep).join("/");

function decodeUtf8(bytes, name) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StagingError(`${name} is not UTF-8 text.`, { code: "not_utf8" });
  }
}

/**
 * The interactive id a staged folder is pushed under, when its post has none.
 *
 * Derived rather than random, so an upload interrupted before it could claim a
 * name lands on the same id when the push runs again, and the draft it already
 * saved still names the right interactive.
 */
export function stagedInteractiveId(postId, name) {
  return `i_${sha256(`staging:${postId}:${name}`).slice(0, 16)}`;
}

// ------------------------------------------------------------------- reading

/**
 * Every file and directory below `root`, links refused.
 *
 * `withFileTypes` reports a link as a link rather than as what it points at, so
 * nothing outside the folder can be read, pushed or deleted through one.
 */
function walk(root) {
  const files = [];
  const dirs = [];
  (function visit(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new StagingError(`${slash(root, full)} is a symbolic link. Staging refuses links rather than follow them.`,
          { code: "symlink", path: full });
      }
      if (entry.isDirectory()) {
        dirs.push(full);
        visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      } else {
        throw new StagingError(`${slash(root, full)} is not a regular file.`, { code: "special_file", path: full });
      }
    }
  })(root);
  return { files, dirs };
}

function readFrontmatter(text, format, name) {
  let parsed;
  try {
    parsed = parseSource(text);
  } catch (err) {
    throw new StagingError(`${name}: the frontmatter could not be read: ${err.message}`, { code: "invalid_frontmatter" });
  }
  const data = parsed.data ?? {};
  const refused = Object.keys(data).filter((key) => !FRONTMATTER_FIELDS.includes(key));
  if (refused.length) {
    throw new StagingError(
      `${name} sets ${refused.join(", ")} in its frontmatter. A pushed post may set only ` +
      `${FRONTMATTER_FIELDS.join(", ")}; engine hooks never reach a browser-authored page (§3.1).`,
      { code: "frontmatter_refused" }
    );
  }
  if (data.format !== undefined && data.format !== format) {
    throw new StagingError(`${name} says it is ${data.format}, but its extension makes it ${format}.`,
      { code: "format_mismatch" });
  }

  const fields = { format };
  for (const key of ["title", "slug", "description"]) {
    if (data[key] !== undefined && data[key] !== null) fields[key] = data[key];
  }
  // YAML reads an unquoted date as a Date at UTC midnight. The draft keeps the
  // date-only string the author wrote.
  if (data.date instanceof Date) fields.date = data.date.toISOString().slice(0, 10);
  else if (data.date !== undefined && data.date !== null) fields.date = String(data.date);
  if (data.tags !== undefined && data.tags !== null) {
    fields.tags = Array.isArray(data.tags) ? data.tags : String(data.tags).split(",");
  }
  return { fields, body: parsed.body };
}

function readConfig(bytes, name, kind) {
  let data;
  try {
    data = JSON.parse(decodeUtf8(bytes, name));
  } catch (err) {
    if (err instanceof StagingError) throw err;
    throw new StagingError(`${name} is not valid JSON.`, { code: "invalid_config" });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new StagingError(`${name} must be a JSON object.`, { code: "invalid_config" });
  }
  const refused = Object.keys(data).filter((key) => !CONFIG_FIELDS.includes(key));
  if (refused.length) {
    throw new StagingError(`${name} sets ${refused.join(", ")}; it may set only ${CONFIG_FIELDS.join(", ")}.`,
      { code: "invalid_config" });
  }
  if (data.kind !== undefined && data.kind !== kind) {
    throw new StagingError(`${name} says this is a ${data.kind}, but the post refers to it as ::${kind}[…].`,
      { code: "wrong_kind" });
  }
  return data;
}

/** What a bundle's config declares, with the conventions filled in. */
function declared(config, kind) {
  return {
    entry: config.entry ?? DEFAULT_ENTRY[kind],
    fallback: config.fallback ?? DEFAULT_FALLBACK,
    dependencies: [...(config.dependencies ?? [])].sort(),
  };
}

function readBundle(folderPath, folder, kind, base) {
  const { files } = walk(folderPath);
  const configPath = path.join(folderPath, BUNDLE_CONFIG);
  const label = `${folder}/`;

  let config = {};
  let configFile = null;
  const localFiles = [];
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    if (file === configPath) {
      config = readConfig(bytes, `${folder}/${BUNDLE_CONFIG}`, kind);
      configFile = { path: file, sha256: sha256(bytes) };
      continue;
    }
    localFiles.push({ path: file, name: slash(folderPath, file), bytes, sha256: sha256(bytes) });
  }

  const input = {
    kind,
    name: base,
    ...declared(config, kind),
    files: localFiles.map(({ name, bytes, sha256: hash }) => ({ name, bytes: bytes.length, sha256: hash })),
  };
  const common = { folder, kind, base, path: folderPath, localFiles, configFile, config };

  let manifest;
  try {
    manifest = validateManifest(input, { postId: PLACEHOLDER_POST });
  } catch (err) {
    if (!(err instanceof InteractiveError)) throw err;
    // A folder without its entry or fallback cannot be pushed as a change, so
    // it is either a mistake or the remainder of a push interrupted while it
    // was deleting — which removes those two first for exactly this reason.
    // Which one is a question for R2, so the decision waits.
    const incomplete = err.code === "empty_bundle" ||
      (err.code === "undeclared_file" && ["entry", "fallback"].includes(err.field));
    if (incomplete) return { ...common, state: "partial", refusal: `${label} ${err.message}` };
    throw new StagingError(`${label} ${err.message}`, {
      code: err.code, path: err.path ? path.join(folderPath, err.path) : folderPath,
    });
  }

  // Publication checks the fallback too. Checking it here makes the refusal
  // free, before a byte has moved.
  const fallback = localFiles.find((file) => file.name === manifest.fallback);
  try {
    validateFallback(decodeUtf8(fallback.bytes, `${folder}/${manifest.fallback}`), {
      files: manifest.files, publicPath: "/",
    });
  } catch (err) {
    if (!(err instanceof InteractiveError)) throw err;
    throw new StagingError(`${label} ${err.message}`, { code: err.code, path: fallback.path });
  }

  return { ...common, state: "complete", input, revisionId: computeRevisionId(manifest) };
}

/**
 * Read a staged post folder, refusing anything the push could not send.
 *
 * Reads, never writes. What it returns carries every staged file's bytes and
 * hash as they were read, which is what confirmation later compares with both
 * R2 and the disk.
 */
export function readStagedPost(dir) {
  const root = path.resolve(String(dir ?? ""));
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    throw new StagingError(`${dir} does not exist.`, { code: "not_found" });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new StagingError(`${dir} is not a folder. Stage a post as a folder holding its source and interactives.`,
      { code: "not_a_folder" });
  }

  const { files, dirs } = walk(root);
  // Only empty folders: what an interruption leaves between the last file and
  // the last directory. There is nothing to push, only something to tidy.
  if (!files.length) return { root, dirs, empty: true };

  const sources = files.filter((file) =>
    path.dirname(file) === root && SOURCE_FORMATS[path.extname(file).toLowerCase()]);
  if (sources.length !== 1) {
    throw new StagingError(sources.length
      ? `${dir} holds ${sources.length} post sources; stage one post per folder.`
      : `${dir} holds no post source (.md, .markdown or .tex).`,
    { code: sources.length ? "several_sources" : "no_source" });
  }

  const sourcePath = sources[0];
  const sourceName = path.basename(sourcePath);
  const sourceBytes = fs.readFileSync(sourcePath);
  const format = SOURCE_FORMATS[path.extname(sourcePath).toLowerCase()];
  // The editor's import normalizes the same two things, so a file pushed from
  // disk and the same file imported in the browser save the same draft.
  const text = decodeUtf8(sourceBytes, sourceName).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const { fields, body } = readFrontmatter(text, format, sourceName);
  const draft = draftFields(fields, body, sourceName);
  try {
    validateForPublish(draft);
  } catch (err) {
    if (!(err instanceof PublishError)) throw err;
    throw new StagingError(`${sourceName}: ${err.message}`, { code: err.code });
  }

  const folders = new Map();
  const ids = [];
  for (const { kind, id: token } of findInteractiveReferences(body, format)) {
    if (isInteractiveId(token)) {
      ids.push({ kind, id: token });
      continue;
    }
    if (!FOLDER.test(token) || token.endsWith(".")) {
      throw new StagingError(`::${kind}[${token}] names neither an interactive id nor a folder beside ${sourceName}.`,
        { code: "invalid_reference" });
    }
    const prior = folders.get(token);
    if (prior && prior !== kind) {
      throw new StagingError(`${token}/ is referred to as both a ${prior} and a ${kind}.`, { code: "wrong_kind" });
    }
    folders.set(token, kind);
  }

  const accounted = new Set([sourcePath]);
  const bundles = [];
  const bases = new Map();
  for (const [folder, kind] of folders) {
    const base = sanitizeInteractiveName(folder);
    if (bases.has(base)) {
      throw new StagingError(`${folder}/ and ${bases.get(base)}/ would both be published as "${base}".`,
        { code: "duplicate_name" });
    }
    bases.set(base, folder);

    const folderPath = path.join(root, folder);
    if (!fs.existsSync(folderPath)) {
      bundles.push({ folder, kind, base, state: "absent", localFiles: [], configFile: null });
      continue;
    }
    if (!dirs.includes(folderPath)) {
      throw new StagingError(`${folder} beside ${sourceName} is not a folder.`, { code: "not_a_folder" });
    }
    const bundle = readBundle(folderPath, folder, kind, base);
    for (const file of bundle.localFiles) accounted.add(file.path);
    if (bundle.configFile) accounted.add(bundle.configFile.path);
    bundles.push(bundle);
  }

  const stray = files.filter((file) => !accounted.has(file));
  if (stray.length) {
    throw new StagingError(
      `Nothing in ${sourceName} sends these, so a push would leave them behind:\n  ` +
      `${stray.map((file) => slash(root, file)).join("\n  ")}\n` +
      "Staging keeps no trace after a push. Move them out, or refer to their folder from the post.",
      { code: "unaccounted_files" }
    );
  }

  return {
    root,
    dirs,
    empty: false,
    source: { path: sourcePath, name: sourceName, sha256: sha256(sourceBytes), format },
    fields,
    body,
    draft,
    ids,
    bundles,
  };
}

function draftFields(fields, body, name) {
  try {
    const normalized = normalizeDraftInput({ ...fields, body });
    return Object.fromEntries([...CONTENT_FIELDS, "tags"].map((key) => [key, normalized[key]]));
  } catch (err) {
    if (!(err instanceof DraftError)) throw err;
    throw new StagingError(`${name}: ${err.message}`, { code: "invalid_post" });
  }
}

const sameContent = (a, b) =>
  CONTENT_FIELDS.every((key) => (a?.[key] ?? "") === (b?.[key] ?? "")) &&
  JSON.stringify(a?.tags ?? []) === JSON.stringify(b?.tags ?? []);

/**
 * What a push records on the draft it saves: a digest of that content.
 *
 * It is how a later push tells its own draft from an author's work. Content
 * alone cannot: a push whose publication was refused leaves a draft the author
 * then fixes on disk, so the next push's source no longer matches it. The
 * digest still describes the draft exactly as long as nobody else saved it.
 */
export const pushedDigest = (fields) => sha256(JSON.stringify([
  ...CONTENT_FIELDS.map((key) => fields?.[key] ?? ""), fields?.tags ?? [],
]));

/** The body with every staged folder name replaced by its interactive id, code left alone. */
function rewriteBody(staged, ids) {
  if (staged.source.format !== "markdown") return staged.body;
  return replaceOutsideCode(staged.body, "markdown", DIRECTIVE, (match) => {
    const id = ids.get(match[2]);
    return id ? `::${match[1]}[${id}]` : match[0];
  });
}

// ------------------------------------------------------------------ transfer

/**
 * PUT one file to the signed URL a bundle upload returned.
 *
 * The URL is a bearer capability, so it never appears in an error or a log.
 */
export async function putToSignedUrl(upload, bytes) {
  const response = await fetch(upload.url, {
    method: upload.method ?? "PUT",
    headers: upload.headers,
    body: bytes,
  });
  await response.arrayBuffer().catch(() => {});
  if (!response.ok) {
    throw new StagingError(`Storage refused ${upload.name} (HTTP ${response.status}).`, { code: "transfer_failed" });
  }
}

// ---------------------------------------------------------------------- push

export function createStagingPush(store, {
  interactives = createInteractives(store),
  drafts = createDraftStore(store),
  publisher = createPublisher(store, { interactives }),
  transfer = putToSignedUrl,
} = {}) {
  /**
   * The post a staged source belongs to, found by its address.
   *
   * Staging keeps no trace, so a local file cannot remember which post it
   * became. The address can: the post at that slug on the site, else the one
   * draft or unpublished post at it. Several is a question only the author can
   * answer, and `postId` is how they answer it.
   */
  async function findTarget(slug, forced) {
    const { data: index } = await publisher.readIndex();
    const liveSlugOf = (postId) =>
      Object.keys(index.posts ?? {}).find((key) => index.posts[key].postId === postId) ?? null;

    let postId = null;
    if (forced !== undefined) {
      if (typeof forced !== "string" || !POST_ID_PATTERN.test(forced)) {
        throw new StagingError(`${forced} is not a post id.`, { code: "invalid_post" });
      }
      postId = forced;
    } else if (index.posts?.[slug]) {
      postId = index.posts[slug].postId;
    } else {
      const candidates = new Map();
      for (const summary of await drafts.list({ limit: Number.MAX_SAFE_INTEGER })) {
        if (summary.slug === slug) candidates.set(summary.postId, summary.title || "untitled");
      }
      for (const [id, entry] of Object.entries(index.unpublished ?? {})) {
        if (entry.slug === slug && !candidates.has(id)) candidates.set(id, "unpublished");
      }
      if (candidates.size > 1) {
        throw new StagingError(
          `Several posts are drafted at /${slug}/: ` +
          `${[...candidates].map(([id, title]) => `${id} (${title})`).join(", ")}. Name one with --post.`,
          { code: "ambiguous_post" }
        );
      }
      [postId = null] = candidates.keys();
    }

    if (!postId) return { postId: null, index, draft: null, live: null, off: null };

    const draft = await drafts.get(postId);
    const liveSlug = liveSlugOf(postId);
    const live = liveSlug ? { slug: liveSlug, ...index.posts[liveSlug] } : null;
    const off = index.unpublished?.[postId] ?? null;
    if (!draft && !live && !off) {
      throw new StagingError(`There is no post ${postId}.`, { code: "not_found" });
    }
    // The publisher refuses both of these too. Refusing here costs no write.
    const holder = index.posts?.[slug];
    if (holder && holder.postId !== postId) {
      throw new StagingError(`The URL /${slug}/ is already used by another post.`, { code: "slug_taken" });
    }
    if (live && live.slug !== slug) {
      throw new StagingError(
        `This post is published at /${live.slug}/, and its address cannot change while it is published.`,
        { code: "slug_locked" }
      );
    }
    return { postId, index, draft, live, off };
  }

  /**
   * The interactive a staged folder name already is on this post, if any.
   *
   * The name claim is what ties a name to an interactive, and it outlives a
   * removed one as a tombstone; a tombstoned name is passed over for the
   * suffixed name the upload path would have claimed next.
   */
  async function existingInteractive(postId, bundle, records) {
    for (let n = 1; n <= MAX_NAME_CLAIMS; n++) {
      const claim = (await store.getJson(keys.interactiveName(postId, nthBundleName(bundle.base, n))))?.data;
      if (!claim) return null;
      const record = records.get(claim.interactiveId);
      if (!record) continue;
      if (record.kind !== bundle.kind) {
        throw new StagingError(
          `This post's ${record.name} is a ${record.kind}; ${bundle.folder}/ is referred to as a ${bundle.kind}.`,
          { code: "wrong_kind" }
        );
      }
      return record;
    }
    return null;
  }

  /**
   * Decide everything a push would do, and refuse what it must not, writing
   * nothing. A dry run is this and no more; an applied push acts on it.
   */
  async function prepare(staged, { postId: forced, replaceDraft = false } = {}) {
    const target = await findTarget(staged.draft.slug, forced);
    const { postId } = target;

    const records = new Map();
    if (postId) for (const record of await interactives.list(postId)) records.set(record.id, record);

    const liveRevisionId = target.live?.revisionId ?? target.off?.revisionId ?? null;
    const liveRevision = postId && liveRevisionId
      ? (await store.getJson(keys.publishedRevision(postId, liveRevisionId)))?.data ?? null
      : null;
    const inUse = new Map((liveRevision?.interactives ?? []).map((item) => [item.id, item]));

    const bundles = [];
    for (const bundle of staged.bundles) {
      const existing = postId ? await existingInteractive(postId, bundle, records) : null;

      if (bundle.state === "complete") {
        const id = existing?.id ?? (postId ? stagedInteractiveId(postId, bundle.base) : null);
        const stored = id
          ? (await store.getJson(keys.interactiveManifest(postId, id, bundle.revisionId)))?.data
          : null;
        // Publication resolves an interactive to its most recent revision. An
        // earlier one pushed again is already stored, and is put back as the
        // one it resolves to rather than transferred.
        const newest = stored?.status === "verified" ? records.get(id) : null;
        const action = !newest ? "upload" : newest.revisionId === bundle.revisionId ? "stored" : "promote";
        bundles.push({ ...bundle, id, action });
        continue;
      }

      if (bundle.state === "absent") {
        if (!existing) {
          throw new StagingError(
            `::${bundle.kind}[${bundle.folder}] names a folder that is not staged, ` +
            `and this post has no ${bundle.kind} called ${bundle.base}.`,
            { code: "unknown_interactive" }
          );
        }
        bundles.push({ ...bundle, id: existing.id, action: "reuse" });
        continue;
      }

      // Partial: the remainder of a push interrupted while deleting, but only
      // if every file still here is byte for byte what the site already
      // publishes for this interactive. Anything else is an incomplete folder.
      const used = existing ? inUse.get(existing.id) : null;
      const published = new Map((used?.files ?? []).map((file) => [file.name, file.sha256]));
      const remainder = used &&
        bundle.localFiles.every((file) => published.get(file.name) === file.sha256) &&
        (!bundle.configFile || configMatches(declared(bundle.config, bundle.kind), used));
      if (!remainder) throw new StagingError(bundle.refusal, { code: "incomplete_bundle", path: bundle.path });
      bundles.push({ ...bundle, id: existing.id, revisionId: used.revisionId, action: "finish" });
    }

    const seen = new Map();
    for (const bundle of bundles) {
      if (bundle.id && seen.has(bundle.id)) {
        throw new StagingError(`${bundle.folder}/ and ${seen.get(bundle.id)}/ are the same interactive on this post.`,
          { code: "duplicate_name" });
      }
      if (bundle.id) seen.set(bundle.id, bundle.folder);
    }
    for (const { kind, id } of staged.ids) {
      const record = records.get(id);
      if (!record || record.kind !== kind) {
        throw new StagingError(
          record
            ? `Interactive ${id} is a ${record.kind}, referred to as a ${kind}.`
            : `This post has no interactive ${id}.`,
          { code: record ? "wrong_kind" : "unknown_interactive" }
        );
      }
    }

    // The draft a push replaces must have nothing in it that would be lost.
    let draftAction = "create";
    let body = null;
    if (postId) {
      const ids = new Map(bundles.map((bundle) => [bundle.folder, bundle.id]));
      body = draftFields(staged.fields, rewriteBody(staged, ids), staged.source.name);
      if (!target.draft) {
        draftAction = "branch";
      } else {
        const current = target.draft.draft;
        const untouched =
          current.revisionId === liveRevisionId ||
          // An editor branch of the live revision that was never saved again.
          (current.publishedRevisionId && current.publishedRevisionId === liveRevisionId &&
            current.createdAt === current.updatedAt) ||
          // Exactly what an earlier push saved, and nobody has saved since.
          (current.pushedDigest && current.pushedDigest === pushedDigest(current)) ||
          sameContent(current, body);
        if (sameContent(current, body)) {
          // Same words, but a folder may have changed: an upload makes a newer
          // revision, and a draft revision already published would otherwise
          // be answered with its old job.
          const expected = new Map(bundles.map((bundle) =>
            [bundle.id, ["upload", "promote"].includes(bundle.action) ? bundle.revisionId : records.get(bundle.id)?.revisionId]));
          for (const { id } of staged.ids) expected.set(id, records.get(id)?.revisionId);
          draftAction = await publishedWithOthers(postId, current.revisionId, expected) ? "save" : "unchanged";
        } else if (untouched) draftAction = "save";
        else if (replaceDraft) draftAction = "replace";
        else {
          throw new StagingError(
            `This post has a draft with changes that are not published (saved ${current.updatedAt}). ` +
            "Pushing would replace them. Publish or discard them in the editor, or push again with " +
            "--replace-draft; the draft's earlier revisions stay in its history.",
            { code: "draft_has_changes" }
          );
        }
      }
    }

    // Interactives the post has and the source no longer names, by folder or
    // by id. A push publishes exactly what the source says, so these go —
    // their stored revisions, not their published copies, which a rollback to
    // an earlier revision still serves, nor their name claims.
    const named = new Set([...bundles.map((bundle) => bundle.id), ...staged.ids.map(({ id }) => id)]);
    const removals = [...records.values()]
      .filter((record) => !named.has(record.id))
      .map(({ id, kind, name }) => ({ id, kind, name }));

    return { target, liveRevisionId, bundles, draftAction, body, removals };
  }

  /**
   * Whether a draft revision was published with interactive revisions other
   * than `expected`. False for one never published: publishing it resolves
   * every interactive afresh.
   */
  async function publishedWithOthers(postId, draftRevisionId, expected) {
    const published = (await store.getJson(keys.publishedRevision(postId, draftRevisionId)))?.data;
    if (!published) return false;
    const was = new Map((published.interactives ?? []).map((item) => [item.id, item.revisionId]));
    return [...expected].some(([id, revisionId]) => was.get(id) !== revisionId);
  }

  /**
   * Confirm a published push against R2 and the disk, then delete what was
   * confirmed. Everything is checked before anything is deleted.
   */
  async function confirmAndRemove(staged, prepared, { postId, draft, ids }) {
    const kept = [];
    const removed = [];
    const keepAll = (files, reason) => { for (const file of files) kept.push({ path: file, reason }); };
    const stagedPaths = (bundle) => [...bundle.localFiles.map((f) => f.path), ...(bundle.configFile ? [bundle.configFile.path] : [])];

    const { data: index } = await publisher.readIndex();
    const entry = index.posts?.[draft.slug];
    const revision = entry?.postId === postId && entry.revisionId === draft.revisionId
      ? (await store.getJson(keys.publishedRevision(postId, draft.revisionId)))?.data
      : null;
    if (!revision) {
      const reason = "the site's index does not name the revision this push published";
      for (const bundle of prepared.bundles) keepAll(stagedPaths(bundle), reason);
      kept.push({ path: staged.source.path, reason });
      return { removed, kept };
    }
    const inRevision = new Map((revision.interactives ?? []).map((item) => [item.id, item]));

    const readDisk = (file) => {
      try {
        return fs.readFileSync(file);
      } catch {
        return null;
      }
    };

    // Phase one reads. A folder is removed whole or not at all: a file that
    // changed on disk during the push keeps its folder intact, so the next push
    // sends the change instead of refusing a folder missing its entry.
    const confirmed = [];
    for (const bundle of prepared.bundles) {
      if (!bundle.localFiles.length && !bundle.configFile) continue;
      const used = inRevision.get(ids.get(bundle.folder));
      if (!used) {
        keepAll(stagedPaths(bundle), "the published revision does not use this interactive");
        continue;
      }
      const published = new Map(used.files.map((file) => [file.name, file.sha256]));
      let reason = null;
      for (const file of bundle.localFiles) {
        const disk = readDisk(file.path);
        if (!disk || sha256(disk) !== file.sha256) reason = `${bundle.folder}/${file.name} changed on disk during the push`;
        else if (published.get(file.name) !== file.sha256) reason = `the published revision declares different bytes for ${bundle.folder}/${file.name}`;
        else {
          const object = await store.get(keys.publishedInteractive(postId, used.id, used.revisionId, file.name));
          if (!object) reason = `R2 does not hold ${bundle.folder}/${file.name}`;
          else if (sha256(object.body) !== file.sha256) reason = `R2 holds different bytes for ${bundle.folder}/${file.name}`;
        }
        if (reason) break;
      }
      if (!reason && bundle.configFile) {
        const disk = readDisk(bundle.configFile.path);
        if (!disk || sha256(disk) !== bundle.configFile.sha256) reason = `${bundle.folder}/${BUNDLE_CONFIG} changed on disk during the push`;
        else if (!configMatches(declared(bundle.config, bundle.kind), used)) reason = `the published ${bundle.kind} does not match ${bundle.folder}/${BUNDLE_CONFIG}`;
      }
      if (reason) keepAll(stagedPaths(bundle), reason);
      else confirmed.push({ bundle, used });
    }

    let sourceReason = null;
    const sourceDisk = readDisk(staged.source.path);
    if (!sourceDisk || sha256(sourceDisk) !== staged.source.sha256) {
      sourceReason = `${staged.source.name} changed on disk during the push`;
    } else {
      const stored = (await store.getJson(keys.draftRevision(postId, draft.revisionId)))?.data;
      if (!sameContent(stored, prepared.body)) sourceReason = "R2 does not hold the draft revision this push saved";
    }

    // A removal the filesystem refuses is reported, not thrown: the post is
    // already published, and what is left is exactly what a re-run finishes.
    const unlink = (file) => {
      try {
        fs.unlinkSync(file);
        removed.push(file);
        return null;
      } catch (err) {
        return `${slash(staged.root, file)} could not be removed (${err.code ?? err.message})`;
      }
    };

    // Phase two deletes. Entry and fallback first, so a folder whose removal
    // stops part way can never be pushed as a change, and a re-run recognizes
    // the rest as the remainder of this push.
    for (const { bundle, used } of confirmed) {
      const first = new Set([used.entry, used.fallback]);
      const order = [...bundle.localFiles].sort((a, b) => Number(!first.has(a.name)) - Number(!first.has(b.name)));
      let stopped = null;
      for (const file of order) {
        if (stopped) {
          kept.push({ path: file.path, reason: stopped });
          continue;
        }
        const disk = readDisk(file.path);
        stopped = !disk || sha256(disk) !== file.sha256
          ? `${bundle.folder}/${file.name} changed on disk during the push`
          : unlink(file.path);
        if (stopped) kept.push({ path: file.path, reason: stopped });
      }
      if (bundle.configFile) {
        const reason = stopped ?? unlink(bundle.configFile.path);
        if (reason) kept.push({ path: bundle.configFile.path, reason });
      }
    }

    // The source last, and only when nothing else stayed: it is what a re-run
    // reads, so it stays exactly as long as there is anything left to push.
    if (!sourceReason && kept.length) sourceReason = "other staged files were kept, and a re-run needs the source";
    if (!sourceReason) {
      const disk = readDisk(staged.source.path);
      if (!disk || sha256(disk) !== staged.source.sha256) sourceReason = `${staged.source.name} changed on disk during the push`;
    }
    sourceReason ??= unlink(staged.source.path);
    if (sourceReason) kept.push({ path: staged.source.path, reason: sourceReason });

    return { removed, kept };
  }

  const api = {
    /** What a push would do, refusing what it must not. Writes nothing. */
    async plan(staged, options = {}) {
      if (staged.empty) return { empty: true, dirs: staged.dirs };
      const prepared = await prepare(staged, options);
      return {
        empty: false,
        slug: staged.draft.slug,
        postId: prepared.target.postId,
        live: prepared.target.live ? prepared.target.live.revisionId : null,
        draft: prepared.draftAction,
        bundles: prepared.bundles.map(({ folder, kind, base, id, revisionId, action, localFiles }) => ({
          folder, kind, name: base, id, revisionId: revisionId ?? null, action,
          files: localFiles.length, bytes: localFiles.reduce((sum, f) => sum + f.bytes.length, 0),
        })),
        removals: prepared.removals,
      };
    },

    /**
     * Push a staged post: draft, bundles, publish, confirm, delete.
     *
     * Throws before publication with every staged file still on disk. After
     * publication it reports what it removed and what it kept, and why.
     */
    async push(staged, { log = () => {}, ...options } = {}) {
      if (staged.empty) return { empty: true, removedDirs: removeEmptyDirs(staged) };
      const prepared = await prepare(staged, options);
      let { postId } = prepared.target;
      let current = prepared.target.draft;

      // 1. A draft, so the bundles have a post to belong to.
      if (!postId) {
        current = await drafts.create(staged.draft, { pushedDigest: pushedDigest(staged.draft) });
        postId = current.draft.postId;
        log(`draft    created ${postId}`);
      } else if (!current) {
        current = await drafts.branchPublished(postId, prepared.liveRevisionId);
        log(`draft    branched from ${prepared.liveRevisionId}`);
      }

      // 2. Bundles, through the same agree, transfer, verify, promote steps the
      //    browser uses. An unchanged folder lands on its stored revision and
      //    transfers nothing.
      const ids = new Map();
      for (const bundle of prepared.bundles) {
        if (bundle.state !== "complete") {
          ids.set(bundle.folder, bundle.id);
          continue;
        }
        const id = bundle.id ?? stagedInteractiveId(postId, bundle.base);
        const agreed = await interactives.begin({ postId, manifest: bundle.input, interactiveId: id });
        if (agreed.revisionId !== bundle.revisionId) {
          throw new StagingError(`${bundle.folder}/ was agreed as a different revision than it was read as.`,
            { code: "revision_mismatch" });
        }
        if (!agreed.unchanged) {
          const bytesOf = new Map(bundle.localFiles.map((file) => [file.name, file.bytes]));
          for (const upload of agreed.uploads) await transfer(upload, bytesOf.get(upload.name));
          const record = await interactives.complete({ postId, uploadId: agreed.uploadId });
          if (record.revisionId !== bundle.revisionId) {
            throw new StagingError(`${bundle.folder}/ was verified as a different revision than it was read as.`,
              { code: "revision_mismatch" });
          }
        }
        ids.set(bundle.folder, id);
        const how = agreed.promoted ? "put back as" : agreed.unchanged ? "already stored as" : "uploaded as";
        log(`${bundle.kind.padEnd(8)} ${bundle.folder}/ ${how} ${bundle.revisionId}`);
      }

      // 3. The source, with ids where it named folders.
      const body = draftFields(staged.fields, rewriteBody(staged, ids), staged.source.name);
      const newest = new Map((await interactives.list(postId)).map((record) => [record.id, record.revisionId]));
      const expected = new Map([...new Set([...ids.values(), ...staged.ids.map(({ id }) => id)])]
        .map((id) => [id, newest.get(id)]));
      if (!sameContent(current.draft, body) ||
          await publishedWithOthers(postId, current.draft.revisionId, expected)) {
        current = await drafts.save(postId, body, current.etag, { pushedDigest: pushedDigest(body) });
        log(`draft    saved ${current.draft.revisionId}`);
      }

      // 4. Publication, exactly as the editor's Publish button does it.
      const job = await publisher.publish(current.draft);
      const hookNote = job.hookError ?? job.deployHook?.skipped;
      log(`publish  ${job.state} at /${job.slug}/${hookNote ? ` — ${hookNote}` : ""}`);

      // 5. Interactives the source stopped naming, only now that the revision
      //    that no longer uses them is published: a push refused before this
      //    point has removed nothing.
      const removedInteractives = [];
      for (const removal of prepared.removals) {
        await interactives.remove(postId, removal.id);
        removedInteractives.push(removal);
        log(`removed  ${removal.kind === "demo" ? "lab" : "figure"} ${removal.name} (${removal.id}), which the source no longer names`);
      }

      // 6. Confirm against R2, then delete what was confirmed.
      const { removed, kept } = await confirmAndRemove(
        staged, { ...prepared, body }, { postId, draft: current.draft, ids }
      );
      const removedDirs = removeEmptyDirs(staged);
      return {
        empty: false,
        postId,
        slug: job.slug,
        revisionId: current.draft.revisionId,
        job,
        removed,
        kept,
        removedDirs,
        removedInteractives,
        complete: kept.length === 0,
      };
    },
  };

  return api;
}

function configMatches(config, published) {
  return config.entry === published.entry &&
    config.fallback === published.fallback &&
    JSON.stringify(config.dependencies) === JSON.stringify([...(published.dependencies ?? [])].sort());
}

/** Remove the staged folder's directories that are now empty, deepest first. Never one with anything in it. */
function removeEmptyDirs(staged) {
  const removed = [];
  const dirs = [...staged.dirs, staged.root].sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    try {
      fs.rmdirSync(dir);
      removed.push(dir);
    } catch (err) {
      if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(err.code)) throw err;
    }
  }
  return removed;
}
