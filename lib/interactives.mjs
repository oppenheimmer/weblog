// The interactive bundle contract (CLAUDE.md §3.6, §4.1).
//
// A bundle is an ordinary small web folder — an entry, some scripts, styles,
// data, and a required static fallback — frozen into an immutable revision.
// Two kinds, differing in the access they are granted rather than in who wrote
// them: a `figure` runs as page code on the post's own page, a `demo` runs in a
// sealed iframe. One contract covers both, because the difference is a grant,
// not a format.
//
// This module is pure: it validates and normalizes a manifest and says what a
// bundle's public paths are. It reads no files and touches no storage, so
// preview, the upload path, publication and the build can all share it — the
// same reason `lib/content.mjs` has no filesystem access.
//
// Three rules it exists to enforce:
//
//   1. **A bundle cannot name anything outside itself.** Every path is
//      relative, normalized and drawn from a character set that survives being
//      a URL segment. Absolute paths, traversal and clever encodings are
//      refused rather than cleaned up, because a path that needed cleaning is
//      a path whose author meant something this format does not offer.
//   2. **A bundle cannot smuggle a document.** HTML is a valid entry only for
//      a sealed lab, and the only other HTML a bundle may contain is its
//      fallback. Every other file is a subresource.
//   3. **A revision is its contents.** The revision id is derived from the
//      manifest, so changing one byte necessarily makes a new revision rather
//      than changing an old post underneath its readers.
import crypto from "node:crypto";

export const INTERACTIVE_SCHEMA_VERSION = 1;

/** Server-generated, unguessable; shape is checked, never trusted. */
export const INTERACTIVE_ID_PATTERN = /^i_[0-9a-f]{16}$/;
/** Derived from the manifest, so it is a fact about the bytes, not a counter. */
export const INTERACTIVE_REVISION_PATTERN = /^iv_[0-9a-f]{16}$/;

export const INTERACTIVE_KINDS = ["figure", "demo"];

// Libraries the engine vendors and serves itself. A bundle asks for one by
// name; it may not supply a URL. §3.6: public-page policy must refuse
// third-party script, so "self-inclusive" has to be enforced, not conventional.
export const VENDORED_DEPENDENCIES = ["d3", "distill"];

// Application limits, not claims about what R2 or a browser will take. A lab is
// a small explanatory program; a bundle approaching any of these is telling us
// it wanted a different feature.
export const LIMITS = {
  filesPerBundle: 100,
  bundleBytes: 10 * 1024 * 1024,   // 10 MiB
  fileBytes: 5 * 1024 * 1024,      //  5 MiB
  pathLength: 120,
  pathDepth: 6,
  perPost: 10,
  dependencies: 8,
  nameLength: 60,
};

// What a bundle may contain, and what each file is served as.
//
// Unlike an attachment, whose extension comes from its verified bytes and never
// from its name (§3.3), a bundle file's type comes from its *name*. §3.6
// requires filenames and relative paths to survive publication intact, because
// `index.html` says `./demo.js` and that script reads `./data.json` — so the
// name is the contract and the served type has to follow it. The bytes are
// still pinned: every file carries a SHA-256 the upload verifies.
export const BUNDLE_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

// Refused by name, with a reason worth keeping. SVG is a document that can
// carry script, and sanitizing one is its own project — the same judgement
// Step 4 made about SVG attachments. A figure's assets are served from the
// post's own origin, so this is not theoretical tidiness.
export const REFUSED_EXTENSIONS = [".svg", ".xml", ".xhtml", ".htm", ".wasm", ".pdf"];

export class InteractiveError extends Error {
  constructor(message, { code = "invalid_bundle", field, path } = {}) {
    super(message);
    this.name = "InteractiveError";
    this.code = code;
    this.field = field;
    this.path = path;
  }
}

const fail = (message, options) => { throw new InteractiveError(message, options); };

export const isInteractiveId = (value) =>
  typeof value === "string" && INTERACTIVE_ID_PATTERN.test(value);

/** The public path segment a bundle is known by: human-readable, like a media name (§3.3). */
export function sanitizeInteractiveName(original) {
  const base = String(original ?? "")
    .replace(/\\/g, "/")
    .split("/").pop()
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    // Decompose accents, then drop the combining marks, or "ü" becomes "u"
    // plus a mark that turns into a separator (the defect Step 4 found).
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.nameLength)
    .replace(/-+$/g, "");
  return base || "interactive";
}

// A path segment becomes a public URL segment, so the set is what survives one
// unambiguously: no spaces, no percent signs, no query or fragment characters,
// nothing needing encoding. A leading dot is refused too — `.` and `..` are
// already out, and a hidden file has no business being published.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/**
 * Check one relative path from a manifest, or refuse it.
 *
 * Refuses rather than repairs. A path that needs repair is one whose author
 * meant something else, and silently rewriting it is how a bundle ends up
 * referring to a file that is no longer where it says it is.
 */
export function normalizeBundlePath(raw, { field = "files" } = {}) {
  if (typeof raw !== "string" || raw === "") {
    fail("Every file in a bundle needs a relative path.", { code: "invalid_path", field });
  }
  const path = raw;
  if (path.length > LIMITS.pathLength) {
    fail(`"${path}" is longer than ${LIMITS.pathLength} characters.`,
      { code: "invalid_path", field, path });
  }
  if (path.includes("\\")) {
    fail(`"${path}" uses backslashes; bundle paths are relative and slash-separated.`,
      { code: "invalid_path", field, path });
  }
  if (path.startsWith("/")) {
    fail(`"${path}" is an absolute path; bundle paths are relative to the bundle.`,
      { code: "invalid_path", field, path });
  }
  if (CONTROL_CHARACTERS.test(path)) {
    fail("A bundle path contains a control character.", { code: "invalid_path", field, path });
  }
  const segments = path.split("/");
  if (segments.length > LIMITS.pathDepth) {
    fail(`"${path}" nests deeper than ${LIMITS.pathDepth} directories.`,
      { code: "invalid_path", field, path });
  }
  for (const segment of segments) {
    if (segment === "") {
      fail(`"${path}" has an empty path segment.`, { code: "invalid_path", field, path });
    }
    if (segment === "." || segment === "..") {
      fail(`"${path}" walks outside the bundle.`, { code: "path_traversal", field, path });
    }
    if (!SEGMENT.test(segment) || segment.endsWith(".")) {
      fail(`"${path}" is not a usable public path. Use letters, digits, dots, dashes and underscores.`,
        { code: "invalid_path", field, path });
    }
  }
  return path;
}

/** The extension, lowercased, including the dot. */
export function extensionOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** What a bundle file is served as, or a refusal naming the extension. */
export function bundleTypeFor(path) {
  const extension = extensionOf(path);
  if (!extension) {
    fail(`"${path}" has no extension, so it cannot be served as anything.`,
      { code: "unsupported_file", path });
  }
  if (REFUSED_EXTENSIONS.includes(extension) || !BUNDLE_TYPES[extension]) {
    fail(`${extension} files are not allowed in a bundle.`, { code: "unsupported_file", path });
  }
  return BUNDLE_TYPES[extension];
}

const isSha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);

/**
 * Validate an author-supplied manifest and return it normalized.
 *
 * What comes back is ordered and complete, so two pushes of the same folder
 * produce the same manifest and therefore the same revision id.
 */
export function validateManifest(input, { postId } = {}) {
  if (!input || typeof input !== "object") {
    fail("A bundle needs a manifest.", { code: "invalid_bundle" });
  }

  const kind = input.kind;
  if (!INTERACTIVE_KINDS.includes(kind)) {
    fail(`A bundle is either a figure or a demo, not "${kind}".`,
      { code: "invalid_kind", field: "kind" });
  }

  // Ownership is decided here, not trusted from the caller: a bundle belonging
  // to another post is a refusal, never a lookup miss (§4.2).
  if (postId && input.postId && input.postId !== postId) {
    fail("That bundle belongs to a different post.", { code: "foreign_bundle", field: "postId" });
  }
  const owner = postId ?? input.postId;
  if (typeof owner !== "string" || owner === "") {
    fail("A bundle must name the post that owns it.", { code: "invalid_bundle", field: "postId" });
  }

  const name = sanitizeInteractiveName(input.name);

  if (!Array.isArray(input.files) || input.files.length === 0) {
    fail("A bundle with no files is not a bundle.", { code: "empty_bundle", field: "files" });
  }
  if (input.files.length > LIMITS.filesPerBundle) {
    fail(`A bundle may hold at most ${LIMITS.filesPerBundle} files.`,
      { code: "too_many_files", field: "files" });
  }

  const files = [];
  const seen = new Map();
  let bytes = 0;
  for (const entry of input.files) {
    if (!entry || typeof entry !== "object") {
      fail("Every file in a bundle needs a path, a size and a hash.",
        { code: "invalid_file", field: "files" });
    }
    const path = normalizeBundlePath(entry.name);
    // Two files differing only in case collide on a case-insensitive
    // filesystem, so a bundle pushed from one would lose a file on the way
    // here and still look complete.
    const folded = path.toLowerCase();
    if (seen.has(folded)) {
      const other = seen.get(folded);
      fail(path === other
        ? `"${path}" is listed twice.`
        : `"${path}" and "${other}" differ only in case.`,
        { code: "duplicate_file", field: "files", path });
    }
    seen.set(folded, path);

    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      fail(`"${path}" does not declare its size.`, { code: "invalid_file", field: "files", path });
    }
    if (entry.bytes > LIMITS.fileBytes) {
      fail(`"${path}" is larger than ${LIMITS.fileBytes / 1024 / 1024} MiB.`,
        { code: "file_too_large", field: "files", path });
    }
    if (!isSha256(entry.sha256)) {
      fail(`"${path}" does not declare a SHA-256.`, { code: "invalid_file", field: "files", path });
    }
    bytes += entry.bytes;
    files.push({
      name: path,
      type: bundleTypeFor(path),
      bytes: entry.bytes,
      sha256: entry.sha256.toLowerCase(),
    });
  }

  if (bytes > LIMITS.bundleBytes) {
    fail(`A bundle may be at most ${LIMITS.bundleBytes / 1024 / 1024} MiB; ` +
      `this one is ${(bytes / 1024 / 1024).toFixed(1)} MiB.`,
      { code: "bundle_too_large", field: "files" });
  }

  const declared = new Set(files.map((f) => f.name));
  const requireDeclared = (path, field) => {
    if (!declared.has(path)) {
      fail(`"${path}" is named as the ${field} but is not one of the bundle's files.`,
        { code: "undeclared_file", field, path });
    }
  };

  const entry = normalizeBundlePath(input.entry, { field: "entry" });
  requireDeclared(entry, "entry");
  const entryExtension = extensionOf(entry);
  if (kind === "demo" && entryExtension !== ".html") {
    fail("A lab's entry is its HTML page.", { code: "invalid_entry", field: "entry", path: entry });
  }
  if (kind === "figure" && entryExtension !== ".mjs") {
    // A figure is imported as a module by the post's own page and exports
    // `mount(root, context)`. An HTML entry would be a document, which is the
    // other pathway and comes with a sandbox.
    fail("A figure's entry is its module, so it must be a .mjs file.",
      { code: "invalid_entry", field: "entry", path: entry });
  }

  const fallback = normalizeBundlePath(input.fallback, { field: "fallback" });
  requireDeclared(fallback, "fallback");
  if (extensionOf(fallback) !== ".html") {
    fail("A bundle's fallback is static HTML.",
      { code: "invalid_fallback", field: "fallback", path: fallback });
  }
  if (fallback === entry) {
    fail("A bundle's fallback cannot also be its entry; the fallback is what readers get instead of it.",
      { code: "invalid_fallback", field: "fallback", path: fallback });
  }

  // Rule 2: no HTML a reader could be navigated to that the contract does not
  // know about. A lab's entry and either kind's fallback are documents on
  // purpose; anything else with an .html name is refused rather than served.
  for (const file of files) {
    if (extensionOf(file.name) !== ".html") continue;
    if (file.name === fallback) continue;
    if (kind === "demo" && file.name === entry) continue;
    fail(`"${file.name}" is an extra HTML page. A bundle serves its entry and its fallback, nothing else.`,
      { code: "unexpected_html", field: "files", path: file.name });
  }

  const dependencies = input.dependencies ?? [];
  if (!Array.isArray(dependencies)) {
    fail("Dependencies are a list of names the engine vendors.",
      { code: "invalid_dependency", field: "dependencies" });
  }
  if (dependencies.length > LIMITS.dependencies) {
    fail(`A bundle may declare at most ${LIMITS.dependencies} dependencies.`,
      { code: "invalid_dependency", field: "dependencies" });
  }
  for (const dependency of dependencies) {
    if (!VENDORED_DEPENDENCIES.includes(dependency)) {
      fail(`"${dependency}" is not a library this engine vendors. ` +
        `Available: ${VENDORED_DEPENDENCIES.join(", ")}. A bundle cannot name a URL.`,
        { code: "invalid_dependency", field: "dependencies" });
    }
  }

  return {
    schemaVersion: INTERACTIVE_SCHEMA_VERSION,
    postId: owner,
    kind,
    name,
    entry,
    fallback,
    dependencies: [...dependencies].sort(),
    files: files.sort((a, b) => a.name.localeCompare(b.name)),
    bytes,
  };
}

/**
 * The revision id for a validated manifest: a fact about its contents.
 *
 * §3.6 asks that changing one byte create a new revision rather than change an
 * old post underneath its readers. Deriving the id from the contents makes that
 * true by construction instead of by discipline — and makes re-pushing an
 * unchanged folder land on the revision that is already there.
 */
export function computeRevisionId(manifest) {
  const canonical = JSON.stringify([
    manifest.schemaVersion, manifest.kind, manifest.entry, manifest.fallback,
    manifest.dependencies,
    manifest.files.map((f) => [f.name, f.type, f.bytes, f.sha256]),
  ]);
  return `iv_${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/**
 * Where a published bundle is served from.
 *
 * Readable and immutable: the post's slug and the bundle's name for people, the
 * revision for cache safety. Labs live under their own `/demos/` prefix so
 * response headers can sandbox them without touching images or figures (§3.6).
 */
export function publicBundlePath(kind, slug, name, revisionId) {
  const root = kind === "demo" ? "/demos" : "/assets/figures";
  return `${root}/${slug}/${name}/${revisionId}/`;
}

/** The public URL of one file inside a published bundle. */
export function publicFileUrl(kind, slug, name, revisionId, file) {
  return `${publicBundlePath(kind, slug, name, revisionId)}${file}`;
}
