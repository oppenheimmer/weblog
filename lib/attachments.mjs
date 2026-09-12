// Turning `attachment://<id>` into a real URL, at publish time (CLAUDE.md §4.2).
//
// Drafts refer to attachments by id, because a draft's images may not be
// published yet and their final names are not known until they are. A published
// revision carries final paths instead, so it is a self-contained document: the
// build performs no reference resolution, a revision can be read or exported
// without the editor, and a draft-only `attachment://` form cannot leak into
// output.
//
// Three rules this module exists to enforce:
//
//   1. **Resolve against this post's manifest only.** An id belonging to another
//      post is not "not found", it is a refusal — otherwise a post could link
//      another post's private uploads into public output.
//   2. **Never rewrite code.** §4.2: "do not use broad string replacement that
//      also rewrites code examples." A post explaining how `attachment://` works
//      must be able to print it literally, so every scan here skips fenced
//      blocks, inline code spans and LaTeX verbatim.
//   3. **Bound expansion.** Snippets may include snippets. Depth, total size and
//      revisits are all capped, so a cycle is an error rather than a hang.

export const MAX_INCLUDE_DEPTH = 5;
export const MAX_EXPANDED_BYTES = 1024 * 1024; // 1 MiB
export const MAX_ATTACHMENTS_PER_POST = 25;
export const MAX_POST_BYTES = 50 * 1024 * 1024; // 50 MiB

/** The fence language that carries a rendered LaTeX snippet in a Markdown post. */
export const TEX_FENCE = "tex-snippet";

export class AttachmentError extends Error {
  constructor(message, { code = "attachment_error", id, field = "body" } = {}) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
    this.id = id;
    this.field = field;
  }
}

/** Attachment ids are server-generated and unguessable; the shape is checked, never trusted. */
export const ATTACHMENT_ID_PATTERN = /^a_[0-9a-f]{16}$/;

export function isAttachmentId(value) {
  return typeof value === "string" && ATTACHMENT_ID_PATTERN.test(value);
}

/** Public URL for a published attachment. Slug-based, so readers see prose (§3.3). */
export function attachmentUrl(slug, publicName) {
  return `/images/uploads/${slug}/${publicName}`;
}

// --------------------------------------------------------------- code regions

/**
 * Byte ranges that must never be rewritten.
 *
 * Markdown: fenced blocks (``` and ~~~, any length) and inline code spans.
 * LaTeX: verbatim environments and `\verb` with any delimiter.
 *
 * Returned as [start, end) pairs over the original string, so the rewriter can
 * ask "is this match inside code?" without re-parsing.
 */
export function codeRegions(source, format) {
  const text = String(source);
  const regions = [];

  if (format === "latex") {
    const verbatim = /\\begin\{(verbatim|lstlisting|minted|Verbatim)\*?\}[\s\S]*?\\end\{\1\*?\}/g;
    for (const match of text.matchAll(verbatim)) {
      regions.push([match.index, match.index + match[0].length]);
    }
    // \verb followed by any non-alphanumeric delimiter, repeated to close.
    const verb = /\\verb\*?(\S)/g;
    for (const match of text.matchAll(verb)) {
      const close = text.indexOf(match[1], match.index + match[0].length);
      regions.push([match.index, close === -1 ? text.length : close + 1]);
    }
    return merge(regions);
  }

  // Fenced blocks: an opening run of >=3 backticks or tildes closes on a run of
  // at least the same length, so a fence can contain shorter fences.
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*\n?/gm;
  let match;
  while ((match = fence.exec(text)) !== null) {
    const marker = match[1];
    const closer = new RegExp(`^[ \\t]*${marker[0]}{${marker.length},}[ \\t]*$`, "m");
    const rest = text.slice(match.index + match[0].length);
    const found = closer.exec(rest);
    const end = found
      ? match.index + match[0].length + found.index + found[0].length
      : text.length; // unterminated fence runs to the end, as markdown-it treats it
    regions.push([match.index, end]);
    fence.lastIndex = end;
  }

  // Inline code spans: a run of backticks closes on an equal-length run.
  const span = /(`+)(?:[^`]|(?!\1)`)*\1/g;
  for (const found of text.matchAll(span)) {
    regions.push([found.index, found.index + found[0].length]);
  }

  return merge(regions);
}

function merge(regions) {
  const sorted = regions.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const region of sorted) {
    const last = out[out.length - 1];
    if (last && region[0] <= last[1]) last[1] = Math.max(last[1], region[1]);
    else out.push([...region]);
  }
  return out;
}

const inside = (regions, index) => regions.some(([start, end]) => index >= start && index < end);

/**
 * Replace every match of `pattern` that is not inside a code region.
 *
 * `replacer` receives the match and returns its replacement. Offsets are
 * recomputed against the original string, so replacements of differing length
 * cannot shift the code map out from under later matches.
 */
export function replaceOutsideCode(source, format, pattern, replacer) {
  const regions = codeRegions(source, format);
  let result = "";
  let last = 0;
  for (const match of String(source).matchAll(pattern)) {
    if (inside(regions, match.index)) continue;
    result += source.slice(last, match.index) + replacer(match);
    last = match.index + match[0].length;
  }
  return result + source.slice(last);
}

// ----------------------------------------------------------------- references

// `![alt](attachment://<id>)` and `[text](attachment://<id>)` alike: the scheme
// appears in a destination, so matching the scheme is enough.
//
// These capture the *whole* target rather than only id-shaped characters. An
// earlier version matched `[A-Za-z0-9_-]+`, so `attachment://../../etc/passwd`
// matched nothing and was silently left unresolved in the published body instead
// of being rejected — and `attachment://<valid-id>/../x` matched just the id and
// resolved it, leaving `/../x` glued to the URL. §4.2 requires traversal to be
// *refused*, so the scan must see the whole thing and then judge it.
const MD_ATTACHMENT = /attachment:\/\/([^\s)\]]*)/g;
// `::tex[<id>]` — the documented standalone directive from §4.2.
const MD_TEX_DIRECTIVE = /::tex\[([^\]]*)\]/g;
// `\includegraphics[opts]{attachments/<id>.ext}` and `\input{attachments/<id>.tex}`.
const TEX_INCLUDEGRAPHICS = /(\\includegraphics\s*(?:\[[^\]]*\])?\s*\{)\s*attachments\/([^}]*?)\s*\}/g;
const TEX_INPUT = /\\input\s*\{\s*attachments\/([^}]*?)\s*\}/g;

/** Strip a trailing extension from a reference target, keeping the id. */
function idFromTarget(target) {
  return String(target).replace(/\.[A-Za-z0-9]+$/, "");
}

/**
 * Every attachment id a source refers to, ignoring code.
 *
 * Used to validate a draft before publishing and to know which objects a
 * revision actually needs.
 */
export function findReferences(body, format) {
  const found = new Set();
  const source = String(body ?? "");
  const regions = codeRegions(source, format);
  const collect = (pattern, extract) => {
    for (const match of source.matchAll(pattern)) {
      if (inside(regions, match.index)) continue;
      found.add(extract(match));
    }
  };

  if (format === "latex") {
    collect(TEX_INCLUDEGRAPHICS, (m) => idFromTarget(m[2]));
    collect(TEX_INPUT, (m) => idFromTarget(m[1]));
  } else {
    collect(MD_ATTACHMENT, (m) => m[1]);
    collect(MD_TEX_DIRECTIVE, (m) => m[1]);
  }
  return [...found];
}

// ------------------------------------------------------------------- resolving

function manifestIndex(attachments, postId) {
  const byId = new Map();
  for (const attachment of attachments ?? []) {
    // Ownership is checked here rather than trusted from the caller: resolving
    // against another post's attachment would publish its private upload.
    if (postId && attachment.postId && attachment.postId !== postId) continue;
    if (attachment.status && attachment.status !== "verified") continue;
    byId.set(attachment.id, attachment);
  }
  return byId;
}

function lookup(byId, id, { allowTraversal = false } = {}) {
  if (!allowTraversal && (id.includes("/") || id.includes("..") || id.includes("\\"))) {
    throw new AttachmentError(
      `"${id}" is not a valid attachment reference.`,
      { code: "invalid_reference", id }
    );
  }
  if (!isAttachmentId(id)) {
    throw new AttachmentError(
      `"${id}" is not a valid attachment id.`,
      { code: "invalid_reference", id }
    );
  }
  const attachment = byId.get(id);
  if (!attachment) {
    throw new AttachmentError(
      `This post refers to an attachment (${id}) that is not attached to it. ` +
      `Attach the file, or remove the reference.`,
      { code: "unknown_attachment", id }
    );
  }
  return attachment;
}

/**
 * Expand a `.tex` snippet, following nested `\input` with bounds.
 *
 * `visiting` is the include stack, so a cycle is reported as a cycle rather
 * than as "too deep", which is a much less useful message.
 */
function expandSnippet(id, { byId, snippets, depth, visiting, budget }) {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new AttachmentError(
      `Attachment includes are nested more than ${MAX_INCLUDE_DEPTH} deep.`,
      { code: "include_too_deep", id }
    );
  }
  if (visiting.includes(id)) {
    throw new AttachmentError(
      `Attachment ${id} includes itself (${[...visiting, id].join(" -> ")}).`,
      { code: "include_cycle", id }
    );
  }

  const attachment = lookup(byId, id);
  if (attachment.kind !== "tex") {
    throw new AttachmentError(
      `Attachment ${id} is an image and cannot be included as a snippet.`,
      { code: "wrong_kind", id }
    );
  }

  // Recorded here, not only at the top level: publishing copies exactly the
  // images reported as used, so an image reachable only through a snippet
  // would otherwise be referenced by the page and missing from the build.
  budget.ids?.add(id);

  const text = snippets?.get?.(id);
  if (typeof text !== "string") {
    throw new AttachmentError(
      `The contents of snippet ${id} could not be read.`,
      { code: "snippet_unavailable", id }
    );
  }

  budget.used += Buffer.byteLength(text, "utf8");
  if (budget.used > MAX_EXPANDED_BYTES) {
    throw new AttachmentError(
      `Expanding attachments produced more than ${MAX_EXPANDED_BYTES / 1024} KiB of text.`,
      { code: "expansion_too_large", id }
    );
  }

  // A snippet may include snippets, and may reference images.
  const nested = { byId, snippets, depth: depth + 1, visiting: [...visiting, id], budget };
  let expanded = replaceOutsideCode(text, "latex", TEX_INPUT, (match) =>
    expandSnippet(idFromTarget(match[1]), nested)
  );
  expanded = replaceOutsideCode(expanded, "latex", TEX_INCLUDEGRAPHICS, (match) => {
    const image = lookup(byId, idFromTarget(match[2]));
    assertImage(image);
    budget.ids?.add(image.id);
    return `${match[1]}${attachmentUrl(budget.slug, image.publicName)}}`;
  });
  return expanded;
}

function assertImage(attachment) {
  if (attachment.kind !== "image") {
    throw new AttachmentError(
      `Attachment ${attachment.id} is a snippet, not an image.`,
      { code: "wrong_kind", id: attachment.id }
    );
  }
}

/**
 * Rewrite a body's attachment references into final public paths.
 *
 * Pure: it is given the manifest and any snippet text rather than fetching
 * them, so the same function serves publish, preview and tests.
 */
export function resolveReferences(body, {
  format = "markdown",
  slug,
  postId,
  attachments = [],
  snippets = new Map(),
} = {}) {
  if (!slug) throw new AttachmentError("A slug is required to build attachment URLs.", { field: "slug" });

  const source = String(body ?? "");
  const byId = manifestIndex(attachments, postId);
  const used = new Set();
  const budget = { used: 0, slug, ids: used };

  if (format === "latex") {
    let out = replaceOutsideCode(source, "latex", TEX_INPUT, (match) => {
      const id = idFromTarget(match[1]);
      used.add(id);
      return expandSnippet(id, { byId, snippets, depth: 1, visiting: [], budget });
    });
    out = replaceOutsideCode(out, "latex", TEX_INCLUDEGRAPHICS, (match) => {
      const attachment = lookup(byId, idFromTarget(match[2]));
      assertImage(attachment);
      used.add(attachment.id);
      return `${match[1]}${attachmentUrl(slug, attachment.publicName)}}`;
    });
    return { body: out, used: [...used] };
  }

  // Markdown. Snippets become a fenced block the renderer understands, rather
  // than inlined HTML: browser-authored Markdown escapes raw HTML, and routing
  // the snippet through a fence keeps it inside the LaTeX pipeline, where the
  // unconditional sanitizer applies.
  let out = replaceOutsideCode(source, "markdown", MD_TEX_DIRECTIVE, (match) => {
    const id = match[1];
    used.add(id);
    const expanded = expandSnippet(id, { byId, snippets, depth: 1, visiting: [], budget });
    return `\n\`\`\`${TEX_FENCE}\n${expanded.replace(/`{3,}/g, "")}\n\`\`\`\n`;
  });

  out = replaceOutsideCode(out, "markdown", MD_ATTACHMENT, (match) => {
    const attachment = lookup(byId, match[1]);
    assertImage(attachment);
    used.add(attachment.id);
    return attachmentUrl(slug, attachment.publicName);
  });

  return { body: out, used: [...used] };
}

/**
 * Check a draft's attachment set before publishing.
 *
 * Separate from resolution so the editor can report problems while writing,
 * without producing a revision.
 */
export function validateAttachments(attachments = []) {
  if (attachments.length > MAX_ATTACHMENTS_PER_POST) {
    throw new AttachmentError(
      `A post may have at most ${MAX_ATTACHMENTS_PER_POST} attachments.`,
      { code: "too_many_attachments", field: "attachments" }
    );
  }
  const total = attachments.reduce((sum, a) => sum + (a.bytes ?? 0), 0);
  if (total > MAX_POST_BYTES) {
    throw new AttachmentError(
      `A post's attachments may total at most ${MAX_POST_BYTES / 1024 / 1024} MiB.`,
      { code: "post_too_large", field: "attachments" }
    );
  }
  const names = new Set();
  for (const attachment of attachments) {
    if (names.has(attachment.publicName)) {
      throw new AttachmentError(
        `Two attachments would publish as ${attachment.publicName}.`,
        { code: "name_collision", id: attachment.id, field: "attachments" }
      );
    }
    names.add(attachment.publicName);
  }
  return attachments;
}
