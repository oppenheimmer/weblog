// Tier 3/4 — attachment reference resolution (CLAUDE.md §4.2).
//
// Two things are being protected here. The obvious one is that a post cannot
// reach another post's files. The subtle one is that a post *about* attachments
// must still be able to print `attachment://` literally in a code example, which
// is why none of this is string replacement.
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveReferences, findReferences, codeRegions, validateAttachments,
  attachmentUrl, isAttachmentId, AttachmentError,
  MAX_INCLUDE_DEPTH, MAX_ATTACHMENTS_PER_POST, TEX_FENCE,
} from "../lib/attachments.mjs";

const A = "a_00000000000000a1";
const B = "a_00000000000000b2";
const SNIPPET = "a_00000000000000c3";
const OTHER_POST = "a_00000000000000d4";

const image = (id, publicName, over = {}) => ({
  id, postId: "p_00000000000000aa", kind: "image", publicName,
  mediaType: "image/png", bytes: 100, width: 8, height: 6, status: "verified", ...over,
});
const snippet = (id, over = {}) => ({
  id, postId: "p_00000000000000aa", kind: "tex", publicName: `${id}.tex`,
  mediaType: "text/x-tex", bytes: 50, status: "verified", ...over,
});

const manifest = [
  image(A, "diagram.png"),
  image(B, "photo.jpg"),
  snippet(SNIPPET),
];

const resolve = (body, options = {}) =>
  resolveReferences(body, {
    slug: "a-post", postId: "p_00000000000000aa", attachments: manifest, ...options,
  });

const fails = (fn) => {
  try { fn(); } catch (err) { return err; }
  return null;
};

// -------------------------------------------------------------- the happy path

test("markdown image references become public paths", () => {
  const { body, used } = resolve(`![A diagram](attachment://${A})`);
  assert.equal(body, "![A diagram](/images/uploads/a-post/diagram.png)");
  assert.deepEqual(used, [A]);
});

test("several references in one document all resolve", () => {
  const { body, used } = resolve(
    `![one](attachment://${A})\n\nText.\n\n![two](attachment://${B})\n\n![again](attachment://${A})`
  );
  assert.match(body, /\/images\/uploads\/a-post\/diagram\.png/);
  assert.match(body, /\/images\/uploads\/a-post\/photo\.jpg/);
  assert.ok(!body.includes("attachment://"), "a reference survived");
  assert.deepEqual(used.sort(), [A, B].sort());
});

test("LaTeX includegraphics resolves and keeps its options", () => {
  const { body } = resolve(`\\includegraphics[width=0.8\\textwidth]{attachments/${A}.png}`, {
    format: "latex",
  });
  assert.equal(body, "\\includegraphics[width=0.8\\textwidth]{/images/uploads/a-post/diagram.png}");
});

test("a published revision never contains attachment:// — that is the point", () => {
  // §4.2: the stored revision must be self-contained, so the build resolves nothing.
  const { body } = resolve(`![x](attachment://${A}) and ::tex[${SNIPPET}]`, {
    snippets: new Map([[SNIPPET, "\\section{Hi}"]]),
  });
  assert.ok(!body.includes("attachment://"));
  assert.ok(!body.includes("::tex["));
});

// ------------------------------------------------------------ code is not code

test("attachment:// inside a fenced block is left alone", () => {
  const body = [
    "Use it like this:",
    "",
    "```markdown",
    `![alt](attachment://${A})`,
    "```",
    "",
    `![real](attachment://${A})`,
  ].join("\n");
  const { body: out } = resolve(body);
  assert.match(out, /```markdown\n!\[alt\]\(attachment:\/\/a_00000000000000a1\)\n```/,
    "the code example was rewritten");
  assert.match(out, /!\[real\]\(\/images\/uploads\/a-post\/diagram\.png\)/,
    "the real reference was not rewritten");
});

test("attachment:// inside an inline code span is left alone", () => {
  const { body } = resolve(`Write \`attachment://${A}\` to embed it.`);
  assert.equal(body, `Write \`attachment://${A}\` to embed it.`);
});

test("a fence containing a shorter fence is still one code region", () => {
  const body = "````\n```\n![x](attachment://" + A + ")\n```\n````";
  const { body: out } = resolve(body);
  assert.ok(out.includes(`attachment://${A}`), "a nested fence was rewritten");
});

test("an unterminated fence swallows the rest of the document, as markdown-it treats it", () => {
  const { body } = resolve("```\n![x](attachment://" + A + ")");
  assert.ok(body.includes(`attachment://${A}`));
});

test("LaTeX verbatim and \\verb are left alone", () => {
  const verbatim = `\\begin{verbatim}\n\\includegraphics{attachments/${A}.png}\n\\end{verbatim}`;
  assert.equal(resolve(verbatim, { format: "latex" }).body, verbatim);

  const verb = `\\verb|\\includegraphics{attachments/${A}.png}|`;
  assert.equal(resolve(verb, { format: "latex" }).body, verb);
});

test("findReferences ignores code too, so validation agrees with resolution", () => {
  const body = "```\n![x](attachment://" + A + ")\n```\n\n![y](attachment://" + B + ")";
  assert.deepEqual(findReferences(body, "markdown"), [B]);
});

test("codeRegions reports mergeable, ordered ranges", () => {
  const regions = codeRegions("a `x` b\n\n```\nfenced\n```\n", "markdown");
  assert.ok(regions.length >= 2);
  for (let i = 1; i < regions.length; i++) {
    assert.ok(regions[i][0] >= regions[i - 1][1], "regions overlap or are unordered");
  }
});

// ------------------------------------------------------------------ ownership

test("an attachment belonging to another post is refused, not merely missing", () => {
  const foreign = [...manifest, image(OTHER_POST, "secret.png", { postId: "p_00000000000000bb" })];
  const err = fails(() => resolve(`![x](attachment://${OTHER_POST})`, { attachments: foreign }));
  assert.ok(err instanceof AttachmentError);
  assert.equal(err.code, "unknown_attachment");
  assert.equal(err.id, OTHER_POST);
});

test("an unverified attachment cannot be referenced", () => {
  const pending = [image(A, "diagram.png", { status: "pending" })];
  const err = fails(() => resolve(`![x](attachment://${A})`, { attachments: pending }));
  assert.equal(err.code, "unknown_attachment");
});

test("an unknown id is a clear error naming the id", () => {
  const err = fails(() => resolve("![x](attachment://a_0000000000000999)"));
  assert.ok(err instanceof AttachmentError);
  assert.equal(err.code, "unknown_attachment");
  assert.match(err.message, /a_0000000000000999/);
});

test("path traversal in a reference is refused", () => {
  for (const hostile of [
    "attachment://../../../etc/passwd",
    "attachment://..%2f..%2fsecret",
    "attachment://a_00000000000000a1/../b",
  ]) {
    const err = fails(() => resolve(`![x](${hostile})`));
    assert.ok(err instanceof AttachmentError, `${hostile} was accepted`);
    assert.equal(err.code, "invalid_reference");
  }
});

test("LaTeX include paths cannot escape the attachments prefix", () => {
  for (const hostile of [
    "\\input{attachments/../../../etc/passwd}",
    "\\includegraphics{attachments/../secret.png}",
  ]) {
    const err = fails(() => resolve(hostile, { format: "latex" }));
    assert.ok(err instanceof AttachmentError, `${hostile} was accepted`);
  }
});

test("a malformed id shape is refused before any lookup", () => {
  const err = fails(() => resolve("![x](attachment://not-an-id)"));
  assert.equal(err.code, "invalid_reference");
  assert.equal(isAttachmentId("not-an-id"), false);
  assert.equal(isAttachmentId(A), true);
});

// -------------------------------------------------------------- kind mismatch

test("a snippet cannot be embedded as an image, nor an image included as a snippet", () => {
  const asImage = fails(() => resolve(`![x](attachment://${SNIPPET})`));
  assert.equal(asImage.code, "wrong_kind");

  const asSnippet = fails(() => resolve(`::tex[${A}]`, { snippets: new Map([[A, "x"]]) }));
  assert.equal(asSnippet.code, "wrong_kind");
});

// ----------------------------------------------------------------- expansion

test("a tex snippet becomes a fenced block the renderer understands", () => {
  const { body } = resolve(`Before\n\n::tex[${SNIPPET}]\n\nAfter`, {
    snippets: new Map([[SNIPPET, "\\section{Hello}\nText."]]),
  });
  assert.match(body, new RegExp("```" + TEX_FENCE + "\\n\\\\section\\{Hello\\}"));
  assert.match(body, /Before/);
  assert.match(body, /After/);
});

test("a snippet may include another snippet", () => {
  const inner = "a_00000000000000e5";
  const attachments = [...manifest, snippet(inner)];
  const { body } = resolve(`::tex[${SNIPPET}]`, {
    attachments,
    snippets: new Map([
      [SNIPPET, `Outer.\n\\input{attachments/${inner}.tex}`],
      [inner, "Inner."],
    ]),
  });
  assert.match(body, /Outer\./);
  assert.match(body, /Inner\./);
});

test("a snippet including itself is reported as a cycle, not as depth", () => {
  const err = fails(() => resolve(`::tex[${SNIPPET}]`, {
    snippets: new Map([[SNIPPET, `\\input{attachments/${SNIPPET}.tex}`]]),
  }));
  assert.ok(err instanceof AttachmentError);
  assert.equal(err.code, "include_cycle");
  assert.match(err.message, /includes itself/);
});

test("a mutual cycle between two snippets terminates", () => {
  const other = "a_00000000000000f6";
  const err = fails(() => resolve(`::tex[${SNIPPET}]`, {
    attachments: [...manifest, snippet(other)],
    snippets: new Map([
      [SNIPPET, `\\input{attachments/${other}.tex}`],
      [other, `\\input{attachments/${SNIPPET}.tex}`],
    ]),
  }));
  assert.equal(err.code, "include_cycle");
});

test("includes deeper than the limit are refused", () => {
  const ids = Array.from({ length: MAX_INCLUDE_DEPTH + 3 }, (_, i) =>
    `a_${String(i).padStart(15, "0")}a`);
  const attachments = ids.map((id) => snippet(id));
  const snippets = new Map(
    ids.map((id, i) => [id, ids[i + 1] ? `\\input{attachments/${ids[i + 1]}.tex}` : "leaf"])
  );
  const err = fails(() => resolve(`::tex[${ids[0]}]`, { attachments, snippets }));
  assert.ok(err instanceof AttachmentError);
  assert.equal(err.code, "include_too_deep");
});

test("expansion that produces too much text is refused", () => {
  const big = "x".repeat(600 * 1024);
  const second = "a_00000000000000e7";
  const err = fails(() => resolve(`::tex[${SNIPPET}]`, {
    attachments: [...manifest, snippet(second)],
    snippets: new Map([
      [SNIPPET, big + `\n\\input{attachments/${second}.tex}`],
      [second, big],
    ]),
  }));
  assert.ok(err instanceof AttachmentError);
  assert.equal(err.code, "expansion_too_large");
});

test("a snippet whose bytes are unavailable fails loudly", () => {
  const err = fails(() => resolve(`::tex[${SNIPPET}]`, { snippets: new Map() }));
  assert.equal(err.code, "snippet_unavailable");
});

test("an image referenced from inside a snippet resolves to a public path", () => {
  const { body } = resolve(`::tex[${SNIPPET}]`, {
    snippets: new Map([[SNIPPET, `\\includegraphics{attachments/${A}.png}`]]),
  });
  assert.match(body, /\/images\/uploads\/a-post\/diagram\.png/);
  assert.ok(!body.includes("attachments/"), "an unresolved include survived");
});

// ----------------------------------------------------------------- manifest

test("public URLs are slug-based and readable, never hashes", () => {
  assert.equal(attachmentUrl("setting-up", "architecture-diagram.png"),
    "/images/uploads/setting-up/architecture-diagram.png");
});

test("a post may not exceed the attachment count or total size", () => {
  const many = Array.from({ length: MAX_ATTACHMENTS_PER_POST + 1 }, (_, i) =>
    image(`a_${String(i).padStart(15, "0")}b`, `x${i}.png`));
  assert.equal(fails(() => validateAttachments(many)).code, "too_many_attachments");

  const huge = [image(A, "a.png", { bytes: 40 * 1024 * 1024 }), image(B, "b.png", { bytes: 20 * 1024 * 1024 })];
  assert.equal(fails(() => validateAttachments(huge)).code, "post_too_large");
});

test("two attachments cannot publish under the same name", () => {
  const clashing = [image(A, "diagram.png"), image(B, "diagram.png")];
  assert.equal(fails(() => validateAttachments(clashing)).code, "name_collision");
});

test("a valid manifest passes", () => {
  assert.deepEqual(validateAttachments(manifest), manifest);
  assert.deepEqual(validateAttachments([]), []);
});
