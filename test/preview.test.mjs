// Tier 3/4 — server-rendered preview (CLAUDE.md §3.1, Step 5).
//
// Three promises, each tested against the thing it promises about rather than
// against the preview's own output:
//
//   * what the author previews is what readers get — compared byte for byte
//     with the page publishing actually produces;
//   * what preview calls an error is exactly what publishing refuses — compared
//     against a real publish attempt on the same draft;
//   * a preview writes nothing, so its signed URLs cannot be stored anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads } from "../lib/server/uploads.mjs";
import { createPublisher, PublishError } from "../lib/server/publish.mjs";
import { loadPublishedPosts } from "../lib/server/published.mjs";
import { createPreviewer, PreviewError, PREVIEW_URL_TTL_SECONDS } from "../lib/server/preview.mjs";
import { keys } from "../lib/server/keys.mjs";
import { postPage } from "../lib/templates.mjs";
import { editorCsp, pageHeaders } from "../lib/server/pages.mjs";
import { createSessionStore, csrfToken } from "../lib/server/sessions.mjs";
import { createRateLimiter } from "../lib/server/rate-limit.mjs";
import { setContext, cookieName } from "../lib/server/http.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const PNG = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "media", "sample-7x11.png")
);
const SIGNED = (key) =>
  `https://weblog-test.fake.r2.cloudflarestorage.com/test/${key}?X-Amz-Expires=600&X-Amz-Signature=abc`;

function harness({ maxBytes } = {}) {
  const client = createFakeS3();
  // Count writes, so "a preview writes nothing" is asserted rather than hoped.
  const writes = [];
  const counting = {
    objects: client.objects,
    send(command) {
      if (/^(Put|Delete|Copy)/.test(command.constructor.name)) writes.push(command.constructor.name);
      return client.send(command);
    },
  };
  const store = createStore({ config: FAKE_CONFIG, client: counting });
  const signedGets = [];
  const signGet = async (key, options) => {
    signedGets.push({ key, ...options });
    return SIGNED(key);
  };
  const uploads = createUploads(store, { signPut: async (key) => `https://signed.test/${key}` });
  return {
    store, writes, signGet, signedGets, uploads,
    drafts: createDraftStore(store),
    previewer: createPreviewer(store, { uploads, signGet, ...(maxBytes ? { maxBytes } : {}) }),
    publisher: createPublisher(store, { uploads, fireDeployHook: async () => ({}) }),
  };
}

async function attach(h, postId, bytes, { name, type = "image/png", kind = "image" }) {
  const signed = await h.uploads.sign({ postId, name, size: bytes.length, type, kind });
  await h.store.put(keys.upload(postId, signed.uploadId, "file"), bytes);
  return h.uploads.complete({ postId, uploadId: signed.uploadId });
}

async function withBody(h, postId, body) {
  const current = await h.drafts.get(postId);
  return (await h.drafts.save(postId, { body }, current.etag)).draft;
}

/** The fields the editor sends: whatever is on screen, plus the post id. */
const onScreen = (draft) => ({
  title: draft.title, date: draft.date, description: draft.description, tags: draft.tags,
  slug: draft.slug, format: draft.format, body: draft.body, postId: draft.postId,
});

/** The article itself, without the page chrome around it. */
const prose = (html) => html.slice(html.indexOf('class="prose'), html.indexOf("</article>"));

// -------------------------------------------------------------------- fidelity

test("a preview is byte-for-byte the page publishing produces", async () => {
  const h = harness();
  const { draft } = await h.drafts.create({
    title: "Parity", date: "2026-09-11", tags: ["maths"], format: "markdown",
    body: "# Heading\n\nEuler: $e^{i\\pi} + 1 = 0$.\n\n```js\nconst x = 1;\n```",
  });

  const preview = await h.previewer.render(onScreen(draft));
  await h.publisher.publish(draft);
  const [published] = await loadPublishedPosts({ store: h.store });

  assert.equal(preview.html, postPage(published), "what the author previews is not what readers get");
  assert.deepEqual(preview.diagnostics, []);
});

test("images come from the verified attachment on a short-lived signed URL, and nothing else differs", async () => {
  const h = harness();
  const { draft: created } = await h.drafts.create({ title: "Pictures", date: "2026-09-11", body: "x" });
  const image = await attach(h, created.postId, PNG, { name: "diagram.png" });
  const draft = await withBody(h, created.postId, `![A diagram](attachment://${image.id})`);

  const preview = await h.previewer.render(onScreen(draft));
  const blobKey = keys.attachmentBlob(draft.postId, "diagram.png");
  assert.deepEqual(h.signedGets.map((s) => s.key), [blobKey], "signed something other than the verified file");
  assert.equal(h.signedGets[0].expiresIn, PREVIEW_URL_TTL_SECONDS);
  assert.ok(PREVIEW_URL_TTL_SECONDS <= 900, "preview image URLs are bearer tokens and must be short-lived");

  const escaped = SIGNED(blobKey).replace(/&/g, "&amp;");
  assert.ok(preview.html.includes(`src="${escaped}"`), "the signed URL is missing or not attribute-escaped");
  assert.ok(!preview.html.includes('src="/images/uploads/'), "the preview points at a published path that does not exist yet");

  await h.publisher.publish(draft);
  const [published] = await loadPublishedPosts({ store: h.store });
  assert.equal(
    preview.html.replace(`src="${escaped}"`, 'src="/images/uploads/pictures/diagram.png"'),
    postPage(published),
    "the preview differs from the published page by more than the image URL"
  );
  // The fixture is 7x11. Both pages reserve that space, which is only true of
  // the preview if it sizes images from the same manifest the build does.
  assert.match(postPage(published), /<img src="\/images\/uploads\/pictures\/diagram\.png" alt="A diagram" width="7" height="11">/);
});

test("a .tex snippet previews inline, as it will publish", async () => {
  const h = harness();
  const { draft: created } = await h.drafts.create({ title: "Snippets", date: "2026-09-11", body: "x" });
  const snippet = await attach(h, created.postId, Buffer.from("\\section{From a snippet}\nWith $x^2$."), {
    name: "part.tex", kind: "tex",
  });
  const draft = await withBody(h, created.postId, `::tex[${snippet.id}]`);
  const preview = await h.previewer.render(onScreen(draft));
  assert.match(preview.html, /class="tex-snippet"/);
  assert.match(preview.html, /From a snippet/);
});

test("an unsaved post previews without attachments or any signing", async () => {
  const h = harness();
  const preview = await h.previewer.render({ title: "Fresh", date: "2026-09-11", body: "Not saved yet." });
  assert.match(preview.html, /Not saved yet\./);
  assert.equal(h.signedGets.length, 0);
});

// ------------------------------------------------------------ parity of refusal

test("a half-written draft still previews, and reports exactly what publishing refuses", async () => {
  const h = harness();
  const { draft } = await h.drafts.create({ body: "Just a thought." });

  const preview = await h.previewer.render(onScreen(draft));
  assert.match(preview.html, /<h1 class="post-title">Untitled<\/h1>/);

  const refusal = await h.publisher.publish(draft).then(() => null, (e) => e);
  assert.ok(refusal instanceof PublishError, "publishing accepted a draft preview called unpublishable");
  const errors = preview.diagnostics.filter((d) => d.level === "error");
  assert.deepEqual(errors.map((e) => [e.code, e.field]), [[refusal.code, refusal.field]]);
});

test("an attachment problem is reported exactly as publishing refuses it", async () => {
  const h = harness();
  const { draft } = await h.drafts.create({
    title: "Refs", date: "2026-09-11", body: "![gone](attachment://a_0000000000000999)",
  });

  const preview = await h.previewer.render(onScreen(draft));
  const refusal = await h.publisher.publish(draft).then(() => null, (e) => e);
  assert.equal(refusal?.code, "unknown_attachment");
  assert.deepEqual(preview.diagnostics.filter((d) => d.level === "error").map((d) => d.code), [refusal.code]);
  assert.ok(!/<img/.test(prose(preview.html)), "an unresolvable reference rendered as an image");
  assert.match(prose(preview.html), /gone/);
});

test("a publishable draft has no errors, so preview never cries wolf", async () => {
  const h = harness();
  const { draft } = await h.drafts.create({ title: "Fine", date: "2026-09-11", body: "All good." });
  const preview = await h.previewer.render(onScreen(draft));
  assert.deepEqual(preview.diagnostics.filter((d) => d.level === "error"), []);
  await h.publisher.publish(draft); // and publishing agrees
});

test("LaTeX the renderer cannot handle is a warning, never a publish blocker", async () => {
  const h = harness();
  const preview = await h.previewer.render({
    title: "TeX", date: "2026-09-11", format: "latex",
    body: "\\foo{x} and \\label{sec:a}.\n\n\\centering\n\n$\\frac{1}{$\n\n\\begin{tikzpicture}\\draw;\\end{tikzpicture}",
  });
  const seen = preview.diagnostics.map((d) => `${d.level}:${d.code}:${d.subject}`);
  assert.ok(seen.includes("warning:unsupported_command:foo"), seen.join(" | "));
  assert.ok(seen.includes("warning:unsupported_command:label"));
  assert.ok(seen.includes("warning:unsupported_environment:tikzpicture"));
  assert.ok(seen.some((s) => s.startsWith("warning:math_error:")));
  assert.ok(!seen.some((s) => s.endsWith(":centering")), "a layout-only macro was reported");
  assert.ok(!preview.diagnostics.some((d) => d.level === "error"));
});

// ---------------------------------------------------------------------- safety

test("a preview writes nothing, so a signed URL can never end up stored", async () => {
  const h = harness();
  const { draft: created } = await h.drafts.create({ title: "Quiet", date: "2026-09-11", body: "x" });
  const image = await attach(h, created.postId, PNG, { name: "diagram.png" });
  const draft = await withBody(h, created.postId, `![x](attachment://${image.id})`);

  h.writes.length = 0;
  await h.previewer.render(onScreen(draft));
  assert.deepEqual(h.writes, [], "a preview wrote to storage");
  assert.match((await h.drafts.get(draft.postId)).draft.body, /attachment:\/\//);
});

const ATTACKS = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  "[x](javascript:alert(1))",
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  "$\\href{javascript:alert(1)}{x}$",
  "```tex-snippet\n\\href{javascript:alert(1)}{x}\n```",
].join("\n\n");

test("the post body adds no script to a preview, whatever it contains", async () => {
  const h = harness();
  const base = { title: "T", date: "2026-09-11" };
  const clean = await h.previewer.render({ ...base, body: "Hello." });
  const hostile = await h.previewer.render({ ...base, body: ATTACKS });

  const scripts = (html) => (html.match(/<script\b/gi) ?? []).length;
  assert.equal(scripts(hostile.html), scripts(clean.html), "the body introduced a script element");
  const article = prose(hostile.html);
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(article), "an event handler reached the preview");
  assert.ok(!/\s(?:href|src)\s*=\s*"\s*javascript:/i.test(article), "a script URL reached the preview");
  assert.ok(!/<iframe/i.test(article), "a frame reached the preview");
});

test("a preview too large to show fails with a clear message", async () => {
  const h = harness({ maxBytes: 3000 });
  const err = await h.previewer.render({ title: "Big", date: "2026-09-11", body: "x" }).then(() => null, (e) => e);
  assert.ok(err instanceof PreviewError);
  assert.equal(err.status, 413);
  assert.equal(err.code, "preview_too_large");
  assert.match(err.message, /Publishing is not affected/);
});

test("a malformed post id is refused", async () => {
  const h = harness();
  const err = await h.previewer.render({ title: "T", postId: "../../etc" }).then(() => null, (e) => e);
  assert.ok(err instanceof PreviewError);
  assert.equal(err.code, "invalid_post");
});

// -------------------------------------------------------------- browser policy

test("the editor CSP admits what a preview needs, and still no inline script", () => {
  const origin = "https://weblog-data.acct.r2.cloudflarestorage.com";
  const csp = editorCsp({ upload: origin, preview: true });
  const directive = (name) =>
    csp.split(";").map((d) => d.trim()).find((d) => d.split(/\s+/)[0] === name) ?? "";

  assert.ok(directive("img-src").split(/\s+/).includes(origin), "signed preview images would be blocked");
  assert.ok(directive("font-src").split(/\s+/).includes("'self'"), "KaTeX fonts would be blocked");
  assert.equal(directive("style-src-attr"), "style-src-attr 'unsafe-inline'", "KaTeX layout would collapse");
  assert.equal(directive("script-src"), "script-src 'self'", "script policy was widened");
  assert.ok(!directive("style-src").includes("unsafe-inline"), "style elements were unblocked along with attributes");
  assert.equal(directive("frame-ancestors"), "frame-ancestors 'none'");
});

test("the login page gets none of the preview's allowances", () => {
  const csp = pageHeaders()["content-security-policy"];
  assert.ok(!csp.includes("style-src-attr"), "the login page allows inline style attributes");
  assert.ok(!/font-src[^;]*'self'/.test(csp));
});

// ----------------------------------------------------------------------- route

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    end(payload) { this.body = payload; return this; },
  };
  res.json = () => JSON.parse(res.body ?? "null");
  return res;
}

const previewRoute = (await import("../api/preview/index.js")).default;

async function routeHarness() {
  const h = harness();
  const sessions = createSessionStore(h.store, { authVersion: 1 });
  setContext({
    store: h.store, sessions, signGet: h.signGet,
    limiter: createRateLimiter(h.store, { secret: "test-secret" }),
  });
  const { token, session } = await sessions.create();
  const call = async ({ body, auth = true, csrf = true } = {}) => {
    const headers = { origin: "http://localhost:3000" };
    if (auth) headers.cookie = `${cookieName()}=${token}`;
    if (auth && csrf) headers["x-csrf-token"] = csrfToken(session);
    const res = fakeRes();
    await previewRoute({ method: "POST", url: "/api/preview/", headers, body }, res);
    return res;
  };
  return { ...h, call };
}

test("route: anonymous and CSRF-less previews are refused", async () => {
  const h = await routeHarness();
  assert.equal((await h.call({ auth: false, body: { title: "T" } })).statusCode, 401);
  assert.equal((await h.call({ csrf: false, body: { title: "T" } })).statusCode, 403);
});

test("route: a preview returns the page and its diagnostics", async () => {
  const h = await routeHarness();
  const res = await h.call({ body: { title: "Route", date: "2026-09-11", body: "Hello $x^2$." } });
  assert.equal(res.statusCode, 200);
  const data = res.json();
  assert.match(data.html, /<h1 class="post-title">Route<\/h1>/);
  assert.ok(Array.isArray(data.diagnostics));
  assert.equal(data.bytes, Buffer.byteLength(data.html));
  assert.equal(res.headers["cache-control"], "no-store");
});

test("route: a body larger than a draft may hold is refused before rendering", async () => {
  const h = await routeHarness();
  const res = await h.call({ body: { title: "T", body: "x".repeat(1_000_001) } });
  assert.equal(res.statusCode, 400);
  assert.ok(!JSON.stringify(res.json()).includes("at "), "a stack trace leaked");
});
