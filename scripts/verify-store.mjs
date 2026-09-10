// Runs lib/server/r2.mjs against the REAL bucket.
//
//   node --env-file=.env scripts/verify-store.mjs
//
// test/r2.test.mjs exercises the same API against an in-memory double. That
// double is only trustworthy while it agrees with R2, and nothing but this
// script checks that. Run it whenever the storage layer or the double changes.
import crypto from "node:crypto";
import { createStore, ConflictError } from "../lib/server/r2.mjs";
import { loadR2Config } from "../lib/server/config.mjs";

const config = { ...loadR2Config(), prefix: `probe-store-${crypto.randomBytes(4).toString("hex")}` };
const store = createStore({ config });
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err?.message });
    console.log(` FAIL  ${name} — ${err?.message}`);
  }
}

const assert = (cond, message) => { if (!cond) throw new Error(message); };

console.log(`Verifying the store module against real R2 under ${config.prefix}/\n`);

await check("absent keys read as null", async () => {
  assert((await store.getJson("missing.json")) === null, "expected null");
  assert((await store.head("missing")) === null, "expected null");
});

await check("JSON round-trips with an ETag", async () => {
  const { etag } = await store.putJson("a.json", { hello: "world" });
  const read = await store.getJson("a.json");
  assert(read.data.hello === "world", "content did not round-trip");
  assert(read.etag === etag, "ETag from put did not match the ETag from get");
});

await check("createJson conflicts on the second call", async () => {
  await store.createJson("once.json", { v: 1 });
  let conflicted = false;
  try {
    await store.createJson("once.json", { v: 2 });
  } catch (err) {
    conflicted = err instanceof ConflictError;
  }
  assert(conflicted, "the second create did not raise ConflictError");
  assert((await store.getJson("once.json")).data.v === 1, "the loser overwrote the winner");
});

await check("updateJson honours a current ETag and rejects a stale one", async () => {
  const created = await store.createJson("doc.json", { v: 1 });
  await store.updateJson("doc.json", { v: 2 }, created.etag);
  let conflicted = false;
  try {
    await store.updateJson("doc.json", { v: 3 }, created.etag);
  } catch (err) {
    conflicted = err instanceof ConflictError;
  }
  assert(conflicted, "a stale ETag was accepted — lost-update protection is not working");
  assert((await store.getJson("doc.json")).data.v === 2, "unexpected final value");
});

await check("concurrent mutateJson calls all land", async () => {
  await Promise.all(
    Array.from({ length: 5 }, () =>
      store.mutateJson("counter.json", (current) => ({ n: (current?.n ?? 0) + 1 }))
    )
  );
  const { data } = await store.getJson("counter.json");
  assert(data.n === 5, `expected 5 increments, got ${data.n}`);
});

await check("listing paginates and strips the prefix", async () => {
  for (let i = 0; i < 7; i++) await store.putJson(`items/${String(i).padStart(2, "0")}.json`, { i });
  const first = await store.list("items/", { limit: 3 });
  assert(first.keys.length === 3, `expected 3 keys, got ${first.keys.length}`);
  assert(first.cursor, "expected a continuation cursor");
  assert(first.keys[0].key === "items/00.json", `prefix not stripped: ${first.keys[0].key}`);
  const all = await store.listAll("items/", { pageSize: 3 });
  assert(all.length === 7, `expected 7 keys, got ${all.length}`);
});

await check("sibling prefixes stay separate", async () => {
  await store.putJson("drafts/a.json", {});
  await store.putJson("published/b.json", {});
  const drafts = await store.listAll("drafts/");
  assert(drafts.length === 1 && drafts[0].key === "drafts/a.json", "prefix isolation failed");
});

await check("server-side copy preserves bytes", async () => {
  await store.put("uploads/pending.bin", Buffer.from("image-bytes"));
  await store.copy("uploads/pending.bin", "published/media/post/diagram.png");
  const copied = await store.get("published/media/post/diagram.png");
  assert(copied.body.toString() === "image-bytes", "copied bytes differ");
});

await check("presigned PUT then read back through the store", async () => {
  const url = await store.signPut("signed.bin", { contentType: "application/octet-stream" });
  const payload = crypto.randomBytes(1024);
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: payload,
  });
  assert(res.ok, `presigned PUT failed: HTTP ${res.status}`);
  const stored = await store.get("signed.bin");
  assert(Buffer.from(stored.body).equals(payload), "bytes differ after presigned upload");
});

// ---- cleanup ---------------------------------------------------------------
console.log("\nCleaning up...");
const leftover = await store.listAll("");
for (const { key } of leftover) await store.delete(key);
console.log(`Deleted ${leftover.length} objects.`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} store checks passed`);
if (failed.length) {
  console.log("The in-memory double in test/helpers/fake-r2.mjs may no longer match real R2.");
  process.exit(1);
}
