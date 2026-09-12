// Throwaway prefixes for the live checks, and the promise that they disappear.
//
// Every live script works under `probe-<what>-<random>/` on the real bucket and
// deletes it at the end. That held only for a run that reached its end: an
// interrupted one left its prefix behind, and sixteen such objects were found
// in the bucket on 2026-09-12, days after the run that made them.
//
// Cleanup now happens on the way out however the script leaves — normally, by
// exception, or on Ctrl-C. That is best effort, not a guarantee: an interrupted
// run's own checks are still in flight, and a write that lands after the last
// sweep pass survives it. Measured: interrupting the concurrency check leaves
// exactly the counter its racers are still writing.
//
// The guarantee is the backstop instead. Every live run sweeps probe debris
// older than an hour, before it starts and again when it ends, so nothing
// accumulates beyond the next run. An hour, because two checks may legitimately
// run at once and neither may delete the other's working set.
import crypto from "node:crypto";

const PROBE = /^probe-[a-z]+-[0-9a-f]{8}\//;
const STALE_MS = 60 * 60 * 1000;

export const probePrefix = (what) => `probe-${what}-${crypto.randomBytes(4).toString("hex")}`;

/**
 * Delete everything under this run's prefix, whenever and however it ends.
 *
 * `store` is scoped to the prefix already, so listing "" is this run's objects
 * and nothing else. Returns a function that cleans up immediately, for a script
 * that wants to report the count itself.
 */
export function cleanUpOnExit(store, { label = "probe" } = {}) {
  let done = false;
  /**
   * Delete this run's objects, repeatedly until the prefix is empty.
   *
   * One pass is not enough on an interrupt: the script keeps running while the
   * sweep lists, so a write that lands between the list and the delete survives
   * it. Measured — a single pass left one object behind.
   */
  const sweep = async () => {
    if (done) return 0;
    done = true;
    let deleted = 0;
    for (let pass = 0; pass < 5; pass++) {
      const leftover = await store.listAll("");
      if (!leftover.length) break;
      for (const { key } of leftover) await store.delete(key);
      deleted += leftover.length;
      // Let whatever is still in flight finish its write, then look again.
      // Bounded, because the script's own work cannot be cancelled from here.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return deleted;
  };

  const onSignal = async (signal) => {
    process.off(signal, onSignal);
    const n = await sweep().catch(() => -1);
    console.log(`\nInterrupted: deleted ${n} ${label} object(s).`);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // An exception that escapes the checks must not leave the bucket dirty either.
  process.once("uncaughtException", async (err) => {
    await sweep().catch(() => {});
    console.error(err);
    process.exit(1);
  });

  return sweep;
}

/**
 * Remove prefixes an earlier run abandoned. Never touches a key outside a probe
 * prefix, and never one written in the last hour.
 *
 * This talks to S3 directly rather than through `createStore`, deliberately. A
 * store is bound to one prefix and cannot see the bucket root — giving it an
 * empty prefix does not widen it, it makes it list "/" and quietly find
 * nothing, which is how the first version of this function was a no-op that
 * reported success. Crossing the prefix boundary is the one thing this
 * function is for, so it does it in the open, and the probe-only guard below
 * is what keeps it safe.
 */
export async function sweepStaleProbes(config, { now = Date.now() } = {}) {
  const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  let cursor;
  let deleted = 0;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket, ContinuationToken: cursor,
    }));
    cursor = page.NextContinuationToken;
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!PROBE.test(key)) continue;                                  // not ours
      if (!object.LastModified) continue;                              // age unknown: leave it
      if (now - new Date(object.LastModified).getTime() <= STALE_MS) continue;  // still in use
      if (!PROBE.test(key)) throw new Error(`refusing to delete ${key}`);
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      deleted++;
    }
  } while (cursor);

  client.destroy();
  return deleted;
}
