import test from "node:test";
import assert from "node:assert/strict";
import { fieldChanges, diffLines } from "../assets/compare.mjs";

test("comparison identifies field and source changes and bounds large edits", () => {
  assert.deepEqual(fieldChanges({ title: "A", tags: ["one"] }, { title: "A", tags: ["two"] }),
    [{ name: "tags", before: ["one"], after: ["two"] }]);
  assert.deepEqual(diffLines("same\nold\nend", "same\nnew\nend").rows,
    [{ kind: "removed", text: "old" }, { kind: "added", text: "new" }]);
  assert.equal(diffLines("same", "same").changed, false);
  const large = diffLines("a\n".repeat(10000), "b\n".repeat(10000));
  assert.equal(large.shortened, true);
  assert.ok(large.rows.length <= 1000);
});
