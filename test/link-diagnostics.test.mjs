import test from "node:test";
import assert from "node:assert/strict";
import { internalLinkDiagnostics } from "../lib/link-diagnostics.mjs";
import { createStore } from "../lib/server/r2.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";
import { createPreviewer } from "../lib/server/preview.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createPublisher } from "../lib/server/publish.mjs";

test("link diagnostics use parsed links, decoded fragments and local routes without fetching external sites", async () => {
  const called = [];
  const post = { slug: "current", html: '<h2 id="local">Here</h2><a href="#local">ok</a><a href="#gone">missing</a><a href="../other/#caf%C3%A9">encoded</a><a href="/missing/">missing page</a><a href="https://elsewhere.test/no/">external</a><code>&lt;a href="/fake/"&gt;</code>' };
  const warnings = await internalLinkDiagnostics(post, { origin: "https://blog.test", resolve: async (path) => {
    called.push(path); return path === "/other/" ? { exists: true, ids: new Set(["café"]) } : { exists: false };
  } });
  assert.deepEqual(warnings.map((w) => w.code), ["missing_internal_anchor", "missing_internal_route"]);
  assert.deepEqual(called, ["/other/", "/missing/"]);
});

test("preview warns about missing article links while the same draft can still publish", async () => {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const drafts = createDraftStore(store);
  const publisher = createPublisher(store, { fireDeployHook: async () => ({}), housekeep: async () => ({}) });
  const target = await drafts.create({ title: "Target", date: "2026-10-29", body: "## Existing" });
  await publisher.publish(target.draft);
  const input = { title: "Linking", date: "2026-10-29", body: "[ok](/target/#existing) [bad](/target/#absent) [gone](/gone/)" };
  const preview = await createPreviewer(store).render(input);
  assert.deepEqual(preview.diagnostics.map((d) => d.code), ["missing_internal_anchor", "missing_internal_route"]);
  const { draft } = await drafts.create(input);
  await publisher.publish(draft);
});
