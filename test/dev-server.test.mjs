// Tier 3 — the local dev command (CLAUDE.md Step 2).
//
// One process serving the built site under vercel.json's rules and the editor's
// real functions, over an in-memory bucket, rebuilding where production would
// fire the deploy hook. Driven here the way a browser would: sign in, write,
// publish, and read the post back from the site the same server serves.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startDevServer } from "../scripts/dev.mjs";

const PASSWORD = "a-dev-server-passphrase";

test("one command serves the site and the editor, and a publish shows up on the local site", async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-dev-"));
  const lines = [];
  const dev = await startDevServer({
    port: 0, memory: true, password: PASSWORD, distDir: path.join(work, "dist"), log: (line) => lines.push(line),
  });
  t.after(async () => {
    await dev.close();
    fs.rmSync(work, { recursive: true, force: true });
  });
  const get = (pathname, options = {}) => fetch(`${dev.url}${pathname}`, { redirect: "manual", ...options });

  // The site, under the platform's rules.
  const home = await get("/");
  assert.equal(home.status, 200);
  // Vercel sends this with every static file; the preview frame's KaTeX fonts
  // need it. A function's response must not carry it.
  assert.equal((await get("/styles/blog.css")).headers.get("access-control-allow-origin"), "*");
  assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'none'/, "vercel.json's header rules were not applied");
  assert.equal((await get("/styles/blog.css")).headers.get("content-type"), "text/css; charset=utf-8");
  assert.deepEqual([(await get("/tags")).status, (await get("/tags")).headers.get("location")], [308, "/tags/"]);
  const missing = await get("/no-such-post/");
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /<html/);

  // The editor and API, through rewrites and the api/ tree.
  assert.deepEqual([(await get("/editor/")).status, (await get("/editor/")).headers.get("location")], [302, "/login/"]);
  const anonymous = await get("/api/drafts/");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("access-control-allow-origin"), null, "a function response became readable by any origin");
  const run = await get("/api/preview/run/not-a-grant/lib/main.mjs");
  assert.deepEqual([run.status, (await run.json()).code], [404, "not_found"], "a Run preview address did not reach its function");

  const login = await get("/api/auth/login/", {
    method: "POST", headers: { origin: dev.url, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const { csrfToken } = await (await get("/api/auth/session/", { headers: { cookie } })).json();
  const call = (pathname, body) => get(pathname, {
    method: "POST", body: JSON.stringify(body),
    headers: { origin: dev.url, cookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
  });

  const created = await (await call("/api/drafts/", {
    title: "Written locally", date: "2026-09-13", slug: "written-locally", body: "Hello from dev.",
  })).json();
  // An image attached and previewed as the editor does it. The links are
  // root-relative, so they work at 127.0.0.1 or localhost alike.
  const png = fs.readFileSync(new URL("./fixtures/media/sample-7x11.png", import.meta.url));
  const signed = await (await call("/api/uploads/", {
    action: "sign", postId: created.draft.postId, name: "still.png", size: png.length, type: "image/png", kind: "image",
  })).json();
  assert.match(signed.url, /^\/local-upload\//, "an upload link names one address, and a page at the other cannot use it");
  assert.equal((await get(signed.url, { method: "PUT", headers: signed.headers, body: png })).status, 200);
  const { attachment } = await (await call("/api/uploads/", { action: "complete", postId: created.draft.postId, uploadId: signed.uploadId })).json();
  const preview = await (await call("/api/preview/", {
    postId: created.draft.postId, title: "Written locally", date: "2026-09-13", slug: "written-locally",
    body: `Hello from dev.\n\n![still](attachment://${attachment.id})\n`,
  })).json();
  const src = /<img src="([^"]+)"/.exec(preview.html)?.[1];
  assert.match(src ?? "", /^\/local-download\//, "a preview image names one address, and a page at the other refuses it");
  assert.deepEqual(Buffer.from(await (await get(src)).arrayBuffer()), png);

  const published = await call("/api/publish/", { postId: created.draft.postId });
  assert.equal(published.status, 200, await published.clone().text());
  await dev.idle();

  const post = await get("/written-locally/");
  assert.equal(post.status, 200, "the publish did not rebuild the local site");
  const html = await post.text();
  assert.match(html, /Hello from dev\./);
  assert.ok(html.includes(`<link rel="canonical" href="${dev.url}/written-locally/"`),
    "canonical URLs do not name the local origin");
  const { publications } = await (await get("/api/publish/", { headers: { cookie } })).json();
  assert.equal(publications[0].site.state, "live", "On the site does not follow the local build");
  assert.ok(lines.some((line) => /^POST \/api\/publish\/ 200/.test(line)), "requests were not logged");
});

test("the dev server refuses the production prefix unless told", async (t) => {
  const before = process.env.R2_PREFIX;
  process.env.R2_PREFIX = "prod";
  t.after(() => {
    if (before === undefined) delete process.env.R2_PREFIX;
    else process.env.R2_PREFIX = before;
  });
  await assert.rejects(() => startDevServer({ port: 0, memory: false }), /R2_PREFIX is "prod"/);
});
