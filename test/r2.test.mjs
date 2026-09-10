// Tier 5 — storage layer semantics.
//
// Runs against the in-memory double, so it needs no credentials. The double's
// behaviour was modelled on what scripts/probe-r2.mjs observed against the real
// bucket; that script is what keeps this honest.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore, ConflictError } from "../lib/server/r2.mjs";
import { readR2Config, assertR2Config, hasR2Config, ConfigError } from "../lib/server/config.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

const newStore = () => {
  const client = createFakeS3();
  return { store: createStore({ config: FAKE_CONFIG, client }), client };
};

// ---------------------------------------------------------------- config

test("config accepts both R2_* and AWS_* credential names", () => {
  const aws = readR2Config({
    R2_ACCOUNT_ID: "acct", AWS_ACCESS_KEY_ID: "ak", AWS_SECRET_ACCESS_KEY: "sk",
  });
  assert.equal(aws.accessKeyId, "ak");
  assert.equal(aws.endpoint, "https://acct.r2.cloudflarestorage.com");

  const both = readR2Config({
    R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "r2", AWS_ACCESS_KEY_ID: "aws",
    R2_SECRET_ACCESS_KEY: "s",
  });
  assert.equal(both.accessKeyId, "r2", "R2_* should win when both are present");
});

test("missing configuration names the fields but never their values", () => {
  let caught;
  try {
    assertR2Config(readR2Config({ AWS_ACCESS_KEY_ID: "super-secret-value" }));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ConfigError);
  assert.match(caught.message, /accountId/);
  assert.ok(!caught.message.includes("super-secret-value"), "a credential value leaked into the error");
});

test("hasR2Config reports whether the build can reach content at all", () => {
  assert.equal(hasR2Config({}), false);
  assert.equal(hasR2Config({
    R2_ACCOUNT_ID: "a", R2_BUCKET: "b", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s",
  }), true);
});

// ---------------------------------------------------------------- keys

test("keys are namespaced by prefix so environments cannot collide", async () => {
  const { store, client } = newStore();
  await store.putJson("drafts/x.json", { a: 1 });
  assert.ok(client.objects.has("test/drafts/x.json"), [...client.objects.keys()].join());
});

test("keys containing .. are refused", () => {
  const { store } = newStore();
  assert.throws(() => store.key("../escape"), TypeError);
  assert.throws(() => store.key("a/../../b"), TypeError);
});

// ---------------------------------------------------------------- round trip

test("absent objects read as null rather than throwing", async () => {
  const { store } = newStore();
  assert.equal(await store.get("nope"), null);
  assert.equal(await store.getJson("nope.json"), null);
  assert.equal(await store.head("nope"), null);
});

test("JSON round-trips and carries an ETag", async () => {
  const { store } = newStore();
  const { etag } = await store.putJson("a.json", { hello: "world" });
  assert.ok(etag);
  const read = await store.getJson("a.json");
  assert.deepEqual(read.data, { hello: "world" });
  assert.equal(read.etag, etag);
});

test("corrupt JSON is reported against its key", async () => {
  const { store } = newStore();
  await store.put("bad.json", "{not json", { contentType: "application/json" });
  await assert.rejects(() => store.getJson("bad.json"), /Corrupt JSON at bad\.json/);
});

// ------------------------------------------------- conditional writes (§3.4)

test("createJson succeeds once and then conflicts", async () => {
  const { store } = newStore();
  await store.createJson("once.json", { v: 1 });
  await assert.rejects(() => store.createJson("once.json", { v: 2 }), ConflictError);
  assert.deepEqual((await store.getJson("once.json")).data, { v: 1 }, "the loser overwrote the winner");
});

test("updateJson with the current ETag succeeds; a stale ETag conflicts", async () => {
  const { store } = newStore();
  const created = await store.createJson("doc.json", { v: 1 });
  await store.updateJson("doc.json", { v: 2 }, created.etag);
  await assert.rejects(() => store.updateJson("doc.json", { v: 3 }, created.etag), ConflictError);
  assert.deepEqual((await store.getJson("doc.json")).data, { v: 2 });
});

test("updateJson refuses to run without an ETag, rather than silently overwriting", async () => {
  const { store } = newStore();
  await store.createJson("doc.json", { v: 1 });
  await assert.rejects(async () => store.updateJson("doc.json", { v: 2 }), TypeError);
});

test("two tabs saving the same draft: the second gets an explicit conflict", async () => {
  const { store } = newStore();
  await store.createJson("draft.json", { body: "original" });

  const tabA = await store.getJson("draft.json");
  const tabB = await store.getJson("draft.json");

  await store.updateJson("draft.json", { body: "from A" }, tabA.etag);
  await assert.rejects(
    () => store.updateJson("draft.json", { body: "from B" }, tabB.etag),
    ConflictError,
    "tab B silently destroyed tab A's work"
  );
  assert.equal((await store.getJson("draft.json")).data.body, "from A");
});

// ---------------------------------------------------------------- mutateJson

test("mutateJson creates when absent and updates when present", async () => {
  const { store } = newStore();
  await store.mutateJson("counter.json", (current) => ({ n: (current?.n ?? 0) + 1 }));
  await store.mutateJson("counter.json", (current) => ({ n: (current?.n ?? 0) + 1 }));
  assert.equal((await store.getJson("counter.json")).data.n, 2);
});

test("mutateJson returning undefined aborts without writing", async () => {
  const { store } = newStore();
  await store.createJson("doc.json", { v: 1 });
  await store.mutateJson("doc.json", () => undefined);
  assert.deepEqual((await store.getJson("doc.json")).data, { v: 1 });
});

test("concurrent mutateJson calls all land, none are lost", async () => {
  const { store } = newStore();
  await Promise.all(
    Array.from({ length: 6 }, () =>
      store.mutateJson("counter.json", (current) => ({ n: (current?.n ?? 0) + 1 }))
    )
  );
  assert.equal((await store.getJson("counter.json")).data.n, 6, "a concurrent increment was lost");
});

// ---------------------------------------------------------------- retries

test("transient failures are retried", async () => {
  const { store, client } = newStore();
  client.failNext(2);
  await store.putJson("a.json", { ok: true });
  assert.deepEqual((await store.getJson("a.json")).data, { ok: true });
});

test("a conflict is never retried away — it is a real answer, not a blip", async () => {
  const { store, client } = newStore();
  await store.createJson("once.json", { v: 1 });
  const before = client.callCount;
  await assert.rejects(() => store.createJson("once.json", { v: 2 }), ConflictError);
  assert.equal(client.callCount - before, 1, "the conflicting write was retried");
});

// ---------------------------------------------------------------- listing

test("listing paginates and strips the environment prefix", async () => {
  const { store } = newStore();
  for (let i = 0; i < 7; i++) await store.putJson(`items/${String(i).padStart(2, "0")}.json`, { i });

  const first = await store.list("items/", { limit: 3 });
  assert.equal(first.keys.length, 3);
  assert.ok(first.cursor, "expected more pages");
  assert.equal(first.keys[0].key, "items/00.json", "prefix was not stripped");

  const all = await store.listAll("items/", { pageSize: 3 });
  assert.equal(all.length, 7);
});

test("an empty prefix lists everything in the environment", async () => {
  const { store } = newStore();
  await store.putJson("drafts/a.json", {});
  await store.putJson("published/b.json", {});
  const all = await store.listAll("");
  assert.deepEqual(all.map((k) => k.key).sort(), ["drafts/a.json", "published/b.json"]);
});

test("a traversal attempt in a list prefix is refused", async () => {
  const { store } = newStore();
  await assert.rejects(() => store.list("../other"), TypeError);
});

test("listing one prefix does not return a sibling prefix", async () => {
  const { store } = newStore();
  await store.putJson("drafts/a.json", {});
  await store.putJson("published/b.json", {});
  const drafts = await store.listAll("drafts/");
  assert.deepEqual(drafts.map((k) => k.key), ["drafts/a.json"]);
});

// ---------------------------------------------------------------- copy

test("server-side copy duplicates bytes without a round trip", async () => {
  const { store } = newStore();
  await store.put("uploads/pending.bin", Buffer.from("image-bytes"));
  await store.copy("uploads/pending.bin", "published/media/post/diagram.png");
  const copied = await store.get("published/media/post/diagram.png");
  assert.equal(copied.body.toString(), "image-bytes");
  assert.ok(await store.get("uploads/pending.bin"), "the source should still exist");
});
