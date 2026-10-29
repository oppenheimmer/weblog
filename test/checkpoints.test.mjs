import test from "node:test";
import assert from "node:assert/strict";
import { createStore, ConflictError } from "../lib/server/r2.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { buildInventory, collectGarbage } from "../lib/server/inventory.mjs";
import { keys } from "../lib/server/keys.mjs";
import { createFakeS3, FAKE_CONFIG } from "./helpers/fake-r2.mjs";

test("named checkpoints survive ordinary revision GC, restore conditionally and are bounded", async () => {
  const client = createFakeS3();
  const store = createStore({ config: FAKE_CONFIG, client });
  const drafts = createDraftStore(store);
  const first = await drafts.create({ title: "Checkpoint", body: "Important text" });
  const checkpoint = await drafts.checkpoint(first.draft.postId, "Before rewrite", first.etag);
  const second = await drafts.save(first.draft.postId, { body: "Rewritten" }, first.etag);
  for (const record of client.objects.values()) record.lastModified = new Date(Date.now() - 40 * 86400_000);
  await collectGarbage(store, { apply: true });
  assert.equal(await drafts.getRevision(first.draft.postId, first.draft.revisionId), null);
  assert.equal((await drafts.getCheckpoint(first.draft.postId, checkpoint.id)).draft.body, "Important text");
  await assert.rejects(() => drafts.restoreCheckpoint(first.draft.postId, checkpoint.id, first.etag), ConflictError);
  const restored = await drafts.restoreCheckpoint(first.draft.postId, checkpoint.id, second.etag);
  assert.equal(restored.draft.version, 3); assert.equal(restored.draft.body, "Important text");
  const other = await drafts.create({ title: "Other" });
  await assert.rejects(() => drafts.getCheckpoint(other.draft.postId, checkpoint.id), /no longer stored/);
  await Promise.all(Array.from({ length: 9 }, (_, i) => drafts.checkpoint(first.draft.postId, `Point ${i}`, restored.etag)));
  await assert.rejects(() => drafts.checkpoint(first.draft.postId, "Eleventh", restored.etag), /ten named/);
  const inventory = await buildInventory(store);
  assert.equal(inventory.unknownKeys.includes(keys.checkpoints(first.draft.postId)), false);
  await drafts.removeCheckpoint(first.draft.postId, checkpoint.id);
  assert.equal((await drafts.checkpoints(first.draft.postId)).length, 9);
  await drafts.remove(first.draft.postId);
  assert.equal(await store.get(keys.checkpoints(first.draft.postId)), null);
});

test("checkpoint names, source size and the version being captured are checked before storing", async () => {
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const drafts = createDraftStore(store);
  const first = await drafts.create({ title: "Large source", body: "x".repeat(900_000) });
  for (const name of ["", " ", "x".repeat(81), null]) {
    await assert.rejects(() => drafts.checkpoint(first.draft.postId, name, first.etag), /name/);
  }
  const current = await drafts.save(first.draft.postId, { body: "y".repeat(900_000) }, first.etag);
  await assert.rejects(() => drafts.checkpoint(first.draft.postId, "Stale", first.etag), ConflictError);
  for (let i = 0; i < 5; i++) await drafts.checkpoint(first.draft.postId, `Large ${i}`, current.etag);
  await assert.rejects(() => drafts.checkpoint(first.draft.postId, "Over quota", current.etag), /5 MiB/);
  assert.equal((await drafts.checkpoints(first.draft.postId)).length, 5);
});
