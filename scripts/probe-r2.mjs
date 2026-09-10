// R2 capability probe — CLAUDE.md §3.4 / Step 0.
//
//   node --env-file=.env scripts/probe-r2.mjs
//
// The plan forbids assuming that "S3-compatible" means every S3 feature exists.
// The whole draft/session/job design rests on conditional writes, so this proves
// them against the real bucket before anything stateful is built on top.
//
// Everything happens under a probe/ prefix and is deleted afterwards. Prints
// pass/fail only — never credentials, never object contents.
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectCommand, ListObjectsV2Command, CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

const ACCOUNT = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET || "weblog-data";
const KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const SECRET = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;

for (const [name, value] of [["R2_ACCOUNT_ID", ACCOUNT], ["access key", KEY_ID], ["secret", SECRET]]) {
  if (!value) {
    console.error(`Missing ${name}. Run with: node --env-file=.env scripts/probe-r2.mjs`);
    process.exit(2);
  }
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
});

const PREFIX = `probe/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const created = [];
const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? "  — " + detail : ""}`);
}

async function attempt(name, fn, { expectFailure = false, expectCode } = {}) {
  try {
    const value = await fn();
    if (expectFailure) {
      record(name, false, "expected a rejection, but the call succeeded");
      return { ok: false, value };
    }
    record(name, true);
    return { ok: true, value };
  } catch (err) {
    const code = err?.name || err?.Code || "unknown";
    const status = err?.$metadata?.httpStatusCode;
    if (expectFailure) {
      const matched = !expectCode || code === expectCode || status === 412;
      record(name, matched, `rejected with ${code}${status ? ` (${status})` : ""}`);
      return { ok: matched };
    }
    record(name, false, `${code}${status ? ` (${status})` : ""}: ${err?.message ?? ""}`.slice(0, 160));
    return { ok: false };
  }
}

const put = (Key, Body, extra = {}) =>
  client.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body, ...extra }));

async function main() {
  console.log(`Probing bucket "${BUCKET}" under ${PREFIX}/\n`);

  // --- reachability ---------------------------------------------------------
  const keyA = `${PREFIX}/a.json`;
  const basic = await attempt("connect, and write an object", async () => {
    const r = await put(keyA, JSON.stringify({ hello: "world" }), { ContentType: "application/json" });
    created.push(keyA);
    return r;
  });
  if (!basic.ok) {
    console.error("\nCannot write to the bucket; every later probe would be noise. Stopping.");
    process.exit(1);
  }

  await attempt("read it back", async () => {
    const r = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyA }));
    const body = JSON.parse(await r.Body.transformToString());
    if (body.hello !== "world") throw new Error("content did not round-trip");
    return r;
  });

  const head = await attempt("HEAD returns an ETag", async () => {
    const r = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: keyA }));
    if (!r.ETag) throw new Error("no ETag on the response");
    return r;
  });
  const etagA = head.value?.ETag;

  // --- the load-bearing part: conditional writes ----------------------------
  console.log("\nConditional writes (the whole draft/session/job design depends on these):");

  const keyB = `${PREFIX}/create-once.json`;
  await attempt("create-if-absent succeeds on a new key (If-None-Match: *)", async () => {
    const r = await put(keyB, JSON.stringify({ v: 1 }), { IfNoneMatch: "*" });
    created.push(keyB);
    return r;
  });

  await attempt(
    "create-if-absent is REJECTED when the key already exists",
    () => put(keyB, JSON.stringify({ v: 2 }), { IfNoneMatch: "*" }),
    { expectFailure: true, expectCode: "PreconditionFailed" }
  );

  const current = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: keyB }));
  await attempt("update with the current ETag succeeds (If-Match)", () =>
    put(keyB, JSON.stringify({ v: 2 }), { IfMatch: current.ETag })
  );

  await attempt(
    "update with a STALE ETag is REJECTED (lost-update protection)",
    () => put(keyB, JSON.stringify({ v: 3 }), { IfMatch: current.ETag }),
    { expectFailure: true, expectCode: "PreconditionFailed" }
  );

  // Two writers racing the same key: exactly one must win.
  await attempt("concurrent racers on one key: exactly one wins", async () => {
    const raceKey = `${PREFIX}/race.json`;
    created.push(raceKey);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => put(raceKey, JSON.stringify({ writer: i }), { IfNoneMatch: "*" }))
    );
    const winners = outcomes.filter((o) => o.status === "fulfilled").length;
    if (winners !== 1) throw new Error(`${winners} writers succeeded; expected exactly 1`);
    return winners;
  });

  // --- read-after-write -----------------------------------------------------
  console.log("\nConsistency and listing:");
  await attempt("read-after-write returns the new value immediately", async () => {
    const k = `${PREFIX}/consistency.json`;
    await put(k, JSON.stringify({ n: 1 }));
    created.push(k);
    await put(k, JSON.stringify({ n: 2 }));
    const r = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }));
    const body = JSON.parse(await r.Body.transformToString());
    if (body.n !== 2) throw new Error(`read a stale value (n=${body.n})`);
    return body;
  });

  await attempt("paginated listing walks every key", async () => {
    const listPrefix = `${PREFIX}/many/`;
    await Promise.all(
      Array.from({ length: 7 }, (_, i) => {
        const k = `${listPrefix}${String(i).padStart(2, "0")}.txt`;
        created.push(k);
        return put(k, `item ${i}`);
      })
    );
    const seen = [];
    let token;
    let pages = 0;
    do {
      const r = await client.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: listPrefix, MaxKeys: 3, ContinuationToken: token,
      }));
      seen.push(...(r.Contents || []).map((o) => o.Key));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
      pages++;
    } while (token);
    if (seen.length !== 7) throw new Error(`saw ${seen.length} of 7 keys`);
    if (pages < 2) throw new Error("MaxKeys did not paginate; cursor logic would be untested");
    return `${seen.length} keys over ${pages} pages`;
  });

  // --- server-side copy: upload -> published media (Step 6) -----------------
  await attempt("server-side copy (pending upload -> published media)", async () => {
    const dest = `${PREFIX}/copied.json`;
    await client.send(new CopyObjectCommand({
      Bucket: BUCKET, Key: dest, CopySource: `/${BUCKET}/${keyA}`,
    }));
    created.push(dest);
    return dest;
  });

  // --- presigned URLs: the browser upload path (Step 4) --------------------
  console.log("\nPresigned URLs (direct browser upload, bypassing the 4.5 MB function cap):");
  const signedKey = `${PREFIX}/presigned.bin`;
  const payload = crypto.randomBytes(2048);

  const signedPut = await attempt("sign a PUT URL", async () => {
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: BUCKET, Key: signedKey, ContentType: "application/octet-stream" }),
      { expiresIn: 300 }
    );
    if (!url.startsWith("https://")) throw new Error("not an https URL");
    return url;
  });

  if (signedPut.ok) {
    await attempt("upload through the presigned PUT", async () => {
      const res = await fetch(signedPut.value, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: payload,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      created.push(signedKey);
      return res.status;
    });

    await attempt("uploaded bytes match what was sent", async () => {
      const r = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: signedKey }));
      const got = Buffer.from(await r.Body.transformToByteArray());
      if (!got.equals(payload)) throw new Error("byte mismatch after presigned upload");
      return `${got.length} bytes`;
    });
  }

  await attempt("sign and fetch a short-lived GET URL (private preview)", async () => {
    const url = await getSignedUrl(
      client, new GetObjectCommand({ Bucket: BUCKET, Key: keyA }), { expiresIn: 120 }
    );
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.status;
  });

  await attempt("the bucket is NOT publicly readable", async () => {
    const res = await fetch(`https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}/${keyA}`);
    if (res.ok) throw new Error(`unauthenticated GET returned ${res.status} — bucket may be public`);
    return `unauthenticated GET refused (${res.status})`;
  });
}

async function cleanup() {
  console.log("\nCleaning up probe objects...");
  let removed = 0;
  for (const Key of [...new Set(created)]) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));
      removed++;
    } catch { /* leave it; the summary reports the count */ }
  }
  const left = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "probe/" }));
  console.log(`Deleted ${removed} objects; ${left.KeyCount ?? 0} left under probe/`);
}

try {
  await main();
} finally {
  await cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} probes passed`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}
