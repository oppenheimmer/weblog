// Tier 3 — what a failed build tells the editor (CLAUDE.md Step 7).
//
// The editor watches the public build manifest, which a failed build never
// publishes, so waiting cannot tell a broken build from a slow one. The build
// records its own failure in R2 and clears it when it next succeeds. These
// tests cover the record and what the publications route does with it.
import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../lib/server/r2.mjs";
import { createPublisher } from "../lib/server/publish.mjs";
import { keys, classifyKey } from "../lib/server/keys.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const harness = () => {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  return { store, publisher: createPublisher(store, { fireDeployHook: async () => ({ job: "d" }) }) };
};

const record = (over = {}) => ({
  schemaVersion: 1, kind: "media", reason: "Published media for /a-post/ is missing: diagram.png",
  commit: "abc123", at: "2026-07-01T00:00:00.000Z", ...over,
});

test("no record means no failure to report", async () => {
  const { publisher } = harness();
  assert.equal(await publisher.lastBuildFailure(), null);
});

test("a recorded failure is reported with its reason", async () => {
  const { store, publisher } = harness();
  await store.put(keys.lastBuildFailure, JSON.stringify(record()));
  const failure = await publisher.lastBuildFailure();
  assert.equal(failure.kind, "media");
  assert.match(failure.reason, /diagram\.png/);
  assert.equal(failure.commit, "abc123");
});

test("a corrupt or half-written record is ignored, never thrown", async () => {
  const { store, publisher } = harness();
  await store.put(keys.lastBuildFailure, "{not json");
  assert.equal(await publisher.lastBuildFailure(), null);

  // Written, but missing the fields that make it meaningful.
  await store.put(keys.lastBuildFailure, JSON.stringify({ schemaVersion: 1 }));
  assert.equal(await publisher.lastBuildFailure(), null);
});

test("the failure record is not owned by any post, so garbage collection leaves it alone", () => {
  const info = classifyKey(keys.lastBuildFailure);
  assert.equal(info.owned, false);
  assert.equal(info.kind, "build-failure");
  assert.equal(info.postId, null);
});

test("it is one key, so failures cannot accumulate the way publication jobs do", async () => {
  const { store } = harness();
  await store.put(keys.lastBuildFailure, JSON.stringify(record({ commit: "one" })));
  await store.put(keys.lastBuildFailure, JSON.stringify(record({ commit: "two" })));
  const keysPresent = (await store.listAll("builds/")).map((o) => o.key);
  assert.deepEqual(keysPresent, [keys.lastBuildFailure]);
});

test("reporting a failure never loses the publications list", async () => {
  const { store, publisher } = harness();
  await store.put(keys.lastBuildFailure, JSON.stringify(record()));
  // A broken store for this one read must not take the whole panel down.
  const broken = { ...store, getJson: async () => { throw new Error("R2 is unwell"); } };
  const guarded = createPublisher(broken, { fireDeployHook: async () => ({}) });
  assert.equal(await guarded.lastBuildFailure(), null);
});
