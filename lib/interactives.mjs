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

import { replaceOutsideCode } from "./attachments.mjs";

export const INTERACTIVE_SCHEMA_VERSION = 1;

/** Server-generated, unguessable; shape is checked, never trusted. */
export const INTERACTIVE_ID_PATTERN = /^i_[0-9a-f]{16}$/;
/** Derived from the manifest, so it is a fact about the bytes, not a counter. */
export const INTERACTIVE_REVISION_PATTERN = /^iv_[0-9a-f]{16}$/;

export const INTERACTIVE_KINDS = ["figure", "demo"];

// Libraries the engine vendors and serves itself. A bundle asks for one by
// name; it may not supply a URL. §3.6: public-page policy must refuse
// third-party script, so "self-inclusive" has to be enforced, not conventional.
//
// The list is what `assets/vendor/` actually holds. `d3` was once offered here
// before it was vendored, which would have published a figure that resolved,
// built and then failed in the reader's browser because nothing defined it; it
// is now served byte for byte from the upstream 7.9.0 release, pinned by hash
// in the tests. A dependency is a promise the engine has to keep.
export const VENDORED_DEPENDENCIES = ["distill", "d3"];

/**
 * Where the engine serves each vendored library from. Same origin, always.
 * Both are classic scripts: distill registers its elements, d3 defines the
 * global `d3` a figure's module reads.
 */
export const VENDORED_SOURCES = {
  distill: "/assets/vendor/distill.template.v2.js",
  d3: "/assets/vendor/d3.v7.9.0.min.js",
};

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

// --------------------------------------------------------------- references
//
// `::demo[<id>]` and `::figure[<id>]` are the only ways a post may mention an
// interactive (§4.2). Both are resolved at publish time into a fenced block
// carrying the bundle's final public path and its fallback, so a published
// revision stays a self-contained document and the build resolves nothing.


/** The fence a resolved interactive travels in, rendered by lib/markdown.mjs. */
export const INTERACTIVE_FENCE = "weblog-interactive";

const MD_DEMO = /::demo\[([^\]]*)\]/g;
const MD_FIGURE = /::figure\[([^\]]*)\]/g;

/** Every interactive id a body refers to, ignoring code. */
export function findInteractiveReferences(body, format) {
  const found = [];
  if (format === "latex") return found;
  const source = String(body ?? "");
  for (const [kind, pattern] of [["demo", MD_DEMO], ["figure", MD_FIGURE]]) {
    replaceOutsideCode(source, "markdown", pattern, (match) => {
      found.push({ kind, id: match[1] });
      return match[0];
    });
  }
  return found;
}

// ------------------------------------------------------------ fallback markup
//
// A bundle's fallback is browser-authored HTML, so §3.1 makes it hostile input.
// It is **validated, not cleaned**: anything outside this list is refused with
// a message naming it, rather than quietly stripped. Cleaning needs a parser
// and gives an author no idea why their page came out different; refusing is
// the same choice the bundle's path rules make, for the same reason.

const FALLBACK_TAGS = new Set([
  "p", "div", "span", "br", "hr", "blockquote", "pre", "code",
  "em", "strong", "small", "sub", "sup", "a", "img",
  "ul", "ol", "li", "dl", "dt", "dd",
  "h3", "h4", "h5", "h6", "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
const FALLBACK_ATTRIBUTES = new Set([
  "class", "alt", "src", "href", "width", "height", "colspan", "rowspan", "scope", "title",
]);
const MAX_FALLBACK_BYTES = 64 * 1024;

const TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/**
 * Check a bundle's fallback, and point its images at their published paths.
 *
 * Returns the HTML a page may inline. Refuses anything it cannot vouch for,
 * including unbalanced tags — an unclosed `<div>` in a fallback would swallow
 * the rest of the article around it.
 */
export function validateFallback(html, { files = [], publicPath = "", servedFrom = null } = {}) {
  const source = String(html ?? "");
  if (Buffer.byteLength(source, "utf8") > MAX_FALLBACK_BYTES) {
    fail(`A fallback may be at most ${MAX_FALLBACK_BYTES / 1024} KiB.`,
      { code: "fallback_too_large", field: "fallback" });
  }
  if (/<!--/.test(source)) {
    fail("A fallback may not contain comments.", { code: "fallback_refused", field: "fallback" });
  }

  const declared = new Set(files.map((file) => file.name));
  const open = [];
  let out = "";
  let last = 0;

  for (const match of source.matchAll(TAG)) {
    const [whole, rawName, rawAttributes] = match;
    const name = rawName.toLowerCase();
    const closing = whole.startsWith("</");

    if (!FALLBACK_TAGS.has(name)) {
      fail(`A fallback may not contain <${name}>.`, { code: "fallback_refused", field: "fallback" });
    }

    out += source.slice(last, match.index);
    last = match.index + whole.length;

    if (closing) {
      if (open.pop() !== name) {
        fail(`The fallback's tags are not balanced around </${name}>.`,
          { code: "fallback_refused", field: "fallback" });
      }
      out += `</${name}>`;
      continue;
    }

    const attributes = [];
    for (const attribute of String(rawAttributes ?? "").matchAll(ATTRIBUTE)) {
      const key = attribute[1].toLowerCase();
      const value = String(attribute[2] ?? "").replace(/^["']|["']$/g, "");
      if (!FALLBACK_ATTRIBUTES.has(key)) {
        fail(`A fallback may not set ${key}="…" on <${name}>.`,
          { code: "fallback_refused", field: "fallback" });
      }
      if (key === "src" && servedFrom) {
        // Read back from a resolved payload, the image already points where
        // resolution put it: inside this bundle's own published directory,
        // and nowhere else.
        let inside = false;
        try {
          inside = value.startsWith(servedFrom) && Boolean(normalizeBundlePath(value.slice(servedFrom.length)));
        } catch {
          inside = false;
        }
        if (!inside) {
          fail(`The fallback's image "${value}" is not one of the bundle's files.`,
            { code: "fallback_refused", field: "fallback" });
        }
        attributes.push(`src="${value}"`);
        continue;
      }
      if (key === "src") {
        // An image in a fallback names a file of the bundle, by the same
        // relative path the bundle uses internally, and is rewritten to where
        // that file will actually be served.
        const relative = value.replace(/^\.\//, "");
        if (!declared.has(relative)) {
          fail(`The fallback's image "${value}" is not one of the bundle's files.`,
            { code: "fallback_refused", field: "fallback" });
        }
        attributes.push(`src="${publicPath}${relative}"`);
        continue;
      }
      if (key === "href" && !/^(https?:\/\/|\/|#|mailto:)/i.test(value)) {
        fail(`The fallback's link "${value}" is not a usable address.`,
          { code: "fallback_refused", field: "fallback" });
      }
      attributes.push(value === "" ? key : `${key}="${value.replace(/"/g, "&quot;")}"`);
    }

    if (!VOID_TAGS.has(name)) open.push(name);
    out += `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}${VOID_TAGS.has(name) ? " /" : ""}>`;
  }

  if (open.length) {
    fail(`The fallback leaves <${open[open.length - 1]}> open.`,
      { code: "fallback_refused", field: "fallback" });
  }
  return (out + source.slice(last)).trim();
}

/**
 * Rewrite a body's interactive references into resolved fenced blocks.
 *
 * Pure, like the attachment resolver: it is handed the bundles and their
 * fallback text rather than fetching them, so publish, preview and tests all
 * run the same function.
 */
export function resolveInteractiveReferences(body, {
  format = "markdown",
  slug,
  postId,
  interactives = [],
  fallbacks = new Map(),
} = {}) {
  const source = String(body ?? "");
  if (format === "latex") {
    // §4.2: LaTeX syntax for interactives waits until the parser can represent
    // it structurally. Raw commands are not an escape hatch, so a LaTeX post
    // simply has no way to name one.
    return { body: source, used: [] };
  }
  if (!slug) {
    fail("A slug is required to build interactive URLs.", { code: "invalid_bundle", field: "slug" });
  }

  const byId = new Map();
  for (const record of interactives) {
    if (postId && record.postId && record.postId !== postId) continue;
    if (record.status && record.status !== "verified") continue;
    byId.set(record.id, record);
  }

  const used = new Set();
  const lookup = (id, kind) => {
    if (!isInteractiveId(id)) {
      fail(`"${id}" is not a valid interactive id.`, { code: "invalid_reference", field: "body" });
    }
    const record = byId.get(id);
    if (!record) {
      fail(`This post refers to an interactive (${id}) that is not attached to it. ` +
        "Attach the bundle, or remove the reference.",
        { code: "unknown_interactive", field: "body" });
    }
    if (record.kind !== kind) {
      fail(`Interactive ${id} is a ${record.kind}, referred to as a ${kind}.`,
        { code: "wrong_kind", field: "body" });
    }
    return record;
  };

  const resolve = (id, kind) => {
    const record = lookup(id, kind);
    used.add(record.id);
    const path = publicBundlePath(record.kind, slug, record.name, record.revisionId);
    const fallback = validateFallback(fallbacks.get(record.id) ?? "", {
      files: record.files,
      publicPath: path,
    });
    const payload = JSON.stringify({
      id: record.id,
      kind: record.kind,
      name: record.name,
      src: `${path}${record.entry}`,
      dependencies: record.dependencies ?? [],
      fallback,
    })
      // A fence cannot contain a fence. Backticks are escaped rather than
      // stripped, because \u0060 parses back to exactly what the author wrote.
      .replace(/`/g, "\\u0060");
    return `\n\`\`\`${INTERACTIVE_FENCE}\n${payload}\n\`\`\`\n`;
  };

  // Figures first, then labs. Neither can match the other's directive, and
  // both skip code regions, so the order is only about reading order.
  let out = replaceOutsideCode(source, "markdown", MD_FIGURE, (match) => resolve(match[1], "figure"));
  out = replaceOutsideCode(out, "markdown", MD_DEMO, (match) => resolve(match[1], "demo"));

  return { body: out, used: [...used] };
}

/**
 * Read a resolved payload back, refusing anything a resolver would not have written.
 *
 * The renderer cannot tell a fence this module produced from one an author
 * typed by hand — a post is free to contain three backticks. So the payload is
 * re-checked at render time, and a `src` that is not a published lab path is
 * refused. Everything inside was already validated at publish time; this is the
 * lock for the case where publication never ran.
 */
const PAYLOAD_SRC = {
  // A lab is a document under its own sandboxed prefix; a figure is a module
  // under the assets tree. The extension is part of the check, because the two
  // pathways differ by exactly the privilege that follows from it.
  demo: /^\/demos\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/iv_[0-9a-f]{16}\/[A-Za-z0-9][A-Za-z0-9._/-]*\.html$/,
  figure: /^\/assets\/figures\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/iv_[0-9a-f]{16}\/[A-Za-z0-9][A-Za-z0-9._/-]*\.mjs$/,
};

export function readInteractivePayload(text) {
  let payload;
  try {
    payload = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const pattern = PAYLOAD_SRC[payload.kind];
  if (!pattern) return null;
  if (typeof payload.src !== "string" || !pattern.test(payload.src)) return null;

  // A figure runs as page code, so what it may pull in is checked here too: a
  // dependency the engine does not serve would otherwise become a script tag
  // pointing nowhere, or wherever the payload said instead.
  const dependencies = Array.isArray(payload.dependencies) ? payload.dependencies : [];
  if (dependencies.some((name) => !VENDORED_DEPENDENCIES.includes(name))) return null;

  try {
    return {
      kind: payload.kind,
      src: payload.src,
      name: sanitizeInteractiveName(payload.name),
      dependencies,
      // An image the resolver pointed into this bundle's directory survives;
      // one pointing anywhere else is refused like any other markup.
      fallback: validateFallback(payload.fallback ?? "", {
        servedFrom: /^\/(?:demos|assets\/figures)\/[^/]+\/[^/]+\/iv_[0-9a-f]{16}\//.exec(payload.src)[0],
      }),
    };
  } catch {
    return null;
  }
}
