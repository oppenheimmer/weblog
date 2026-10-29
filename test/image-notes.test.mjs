import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizePost } from "../lib/content.mjs";
import { resolveReferences, findReferences } from "../lib/attachments.mjs";
import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads } from "../lib/server/uploads.mjs";
import { createPublisher } from "../lib/server/publish.mjs";
import { createPreviewer } from "../lib/server/preview.mjs";
import { postExportManifest } from "../lib/server/export.mjs";
import { keys } from "../lib/server/keys.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";
import { imageDetails } from "../lib/image-notes.mjs";

test("image blocks resolve owned bytes and render safe, distinct alt/caption/credit/description in both formats", () => {
  const id = "a_0000000000000001";
  const notes = { alt: "Short alternative", caption: '<script>caption</script>', credit: "Author", description: "Trend details and a literal ::tex[a_missing] attachment://example" };
  for (const format of ["markdown", "latex"]) {
    const body = `::image[${id}] ${JSON.stringify(notes)}`;
    assert.deepEqual(findReferences(body, format), [id]);
    const resolved = resolveReferences(body, { format, slug: "notes", attachments: [{ id, kind: "image", publicName: "plot.png" }] });
    assert.deepEqual(resolved.used, [id]);
    const post = normalizePost({ data: { title: "Notes", date: "2026-10-29", slug: "notes" }, format, body: resolved.body });
    assert.ok(post.html.includes('<figure class="article-image">'));
    assert.ok(post.html.includes('<p class="image-caption">'));
    assert.ok(post.html.includes('<p class="image-description">'));
    assert.ok(post.html.includes('alt="Short alternative"'));
    assert.ok(post.html.includes('&lt;script&gt;caption&lt;/script&gt;'));
    assert.ok(post.html.includes('Credit: Author'));
    assert.ok(!post.html.includes('<script>'));
  }
  const code = '```text\n::image[a_missing] {"caption":"literal"}\n```';
  assert.deepEqual(findReferences(code, "markdown"), []);
  assert.equal(resolveReferences(code, { slug: "code" }).body, code);
  assert.throws(() => normalizePost({ data: { title: "Bad", date: "2026-10-29", slug: "bad" }, format: "markdown", body: '::image[https://bad.test/a.png] {"caption":"bad"}' }), /local published image/);
  const snippetId = "a_0000000000000002";
  const nested = resolveReferences(`::tex[${snippetId}]`, {
    format: "markdown", slug: "nested",
    attachments: [{ id, kind: "image", publicName: "plot.png" }, { id: snippetId, kind: "tex", publicName: "note.tex" }],
    snippets: new Map([[snippetId, `::image[${id}] ${JSON.stringify(notes)}`]]),
  });
  assert.deepEqual(nested.used, [snippetId, id]);
  assert.ok(normalizePost({ data: { title: "Nested", date: "2026-10-29" }, format: "markdown", body: nested.body }).html.includes('class="image-caption"'));
});

test("image details reject malformed fields and leave note content literal", () => {
  for (const raw of ['{', '[]', 'null', '{"onerror":"bad"}', '{"caption":3}', '{"toString":"bad"}', JSON.stringify({ description: "x".repeat(10001) })]) {
    assert.throws(() => imageDetails(raw));
  }
  for (const format of ["markdown", "latex"]) {
    const body = '::image[a_missing] {"caption":"A `code` example, ::tex[a_other] and attachment://literal"}';
    assert.deepEqual(findReferences(body, format), ["a_missing"]);
    assert.throws(() => resolveReferences(body, { format, slug: "notes" }), /a_missing/);
  }
  const captionTick = '::image[a_first] {"caption":"A single `"}\n\n![second](attachment://a_second)\n\nA closing ` sign.';
  assert.deepEqual(findReferences(captionTick, "markdown"), ["a_first", "a_second"]);
  const captionVerb = '::image[a_first] {"caption":"A literal \\\\verb|"}\n\n\\includegraphics{attachments/a_second.png}\n\nA closing | sign.';
  assert.deepEqual(findReferences(captionVerb, "latex"), ["a_first", "a_second"]);
});

for (const format of ["markdown", "latex"]) test(`image details survive ${format} preview, immutable publication and source export without leaking attachment ids publicly`, async () => {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const drafts = createDraftStore(store);
  const uploads = createUploads(store, { signPut: async () => "https://unused.test" });
  const { draft, etag } = await drafts.create({ title: "Diagram", date: "2026-10-29", format });
  const bytes = fs.readFileSync(new URL("./fixtures/media/sample-7x11.png", import.meta.url));
  const pending = await uploads.sign({ postId: draft.postId, name: "plot.png", type: "image/png", size: bytes.length });
  await store.put(keys.upload(draft.postId, pending.uploadId, "file"), bytes);
  const image = await uploads.complete({ postId: draft.postId, uploadId: pending.uploadId });
  const source = `::image[${image.id}] {"alt":"Plot","caption":"Measured trend","credit":"Owner","description":"Values grow with time."}`;
  const saved = await drafts.save(draft.postId, { body: source }, etag);
  const preview = await createPreviewer(store, { signGet: async () => "https://signed.test/verified.png" }).render({ ...saved.draft, postId: draft.postId });
  assert.ok(preview.html.includes('src="https://signed.test/verified.png"'));
  assert.ok(preview.html.includes("Measured trend"));
  const publisher = createPublisher(store, { fireDeployHook: async () => ({}), housekeep: async () => ({}) });
  await publisher.publish(saved.draft);
  const publication = (await store.getJson(keys.publishedRevision(draft.postId, saved.draft.revisionId))).data;
  assert.equal(publication.media.length, 1);
  assert.ok(!publication.body.includes(image.id));
  const exported = await postExportManifest(store, draft.postId);
  assert.ok(exported.virtual.find((f) => f.path === (format === "latex" ? "post.tex" : "post.md")).text.includes(source));
  assert.ok(exported.files.some((f) => f.path === `images/${image.publicName}`));
});
