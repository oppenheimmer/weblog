// Preloaded only in the output-hygiene test's child process. The real build
// sees production-shaped configuration, but every S3 request stays in memory.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { S3Client } from "@aws-sdk/client-s3";
import { createStore } from "../../lib/server/r2.mjs";
import { createDraftStore } from "../../lib/server/drafts.mjs";
import { createPublisher } from "../../lib/server/publish.mjs";
import { createUploads } from "../../lib/server/uploads.mjs";
import { createInteractives } from "../../lib/server/interactives.mjs";
import { createPreviewer } from "../../lib/server/preview.mjs";
import { keys } from "../../lib/server/keys.mjs";
import { createFakeS3, FAKE_CONFIG } from "./fake-r2.mjs";

const privateValues = {
  R2_ACCESS_KEY_ID: "audit-private-access-key-619a",
  R2_SECRET_ACCESS_KEY: "audit-private-storage-secret-729b",
  ADMIN_PASSWORD_HASH: "audit-private-password-hash-830c",
  RATE_LIMIT_HASH_SECRET: "audit-private-rate-secret-941d",
  VERCEL_DEPLOY_HOOK_URL: "https://deploy.invalid/audit-private-hook-a52e",
  unpublished: "audit-private-unpublished-body-b63f",
  newerDraft: "audit-private-newer-draft-c740",
  session: "audit-private-session-token-d851",
  upload: "audit-private-pending-upload-e962",
  metadata: "audit-private-revision-metadata-fa73",
  signature: "audit-private-preview-signature-ab84",
  privateFile: process.env.BUILD_AUDIT_FILE_CANARY,
};
for (const name of Object.keys(process.env)) {
  if (/^(?:R2_|AWS_|BLOG_)/.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  R2_ACCOUNT_ID: "audit-account", R2_BUCKET: "audit-bucket", R2_PREFIX: "prod",
  R2_ENDPOINT: "https://storage.invalid",
  ...Object.fromEntries(Object.entries(privateValues).filter(([key]) => /^[A-Z0-9_]+$/.test(key))),
  VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "audit-public-commit",
  BLOG_DIST_DIR: process.env.BUILD_AUDIT_DIST,
});

const client = createFakeS3();
S3Client.prototype.send = (command) => client.send(command);
const store = createStore({ config: { ...FAKE_CONFIG, prefix: "prod" }, client });
const drafts = createDraftStore(store);
const signedUrl = `https://storage.invalid/private?X-Amz-Signature=${privateValues.signature}&X-Amz-Expires=600`;
const uploads = createUploads(store, { signPut: async () => signedUrl });
const bundles = createInteractives(store, { signPut: async () => signedUrl });
const publisher = createPublisher(store, {
  uploads, interactives: bundles, fireDeployHook: async () => ({}),
});
let { draft, etag } = await drafts.create({
  title: "Public audit post", slug: "public-audit", date: "2026-09-13",
  tags: ["audit"], body: "Public audit seed.",
});

async function attach(name, bytes, type, kind) {
  const pending = await uploads.sign({ postId: draft.postId, name, size: bytes.length, type, kind });
  await store.put(keys.upload(draft.postId, pending.uploadId, "file"), bytes);
  return uploads.complete({ postId: draft.postId, uploadId: pending.uploadId });
}
const png = fs.readFileSync(new URL("../fixtures/media/sample-7x11.png", import.meta.url));
const image = await attach("diagram.png", png, "image/png", "image");
const tex = await attach("equation.tex", Buffer.from("\\[E = mc^2\\]"), "text/x-tex", "tex");

const publicBundles = [];
async function bundle(kind, name, files, entry) {
  const begun = await bundles.begin({ postId: draft.postId, manifest: {
    kind, name, entry, fallback: "fallback.html",
    files: Object.entries(files).map(([name, body]) => ({
      name, bytes: Buffer.byteLength(body),
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
    })),
  } });
  for (const [name, body] of Object.entries(files)) {
    await store.put(keys.upload(draft.postId, begun.uploadId, `files/${name}`), body);
  }
  const record = await bundles.complete({ postId: draft.postId, uploadId: begun.uploadId });
  const base = `${kind === "demo" ? "demos" : "assets/figures"}/public-audit/${name}/${record.revisionId}`;
  for (const [file, body] of Object.entries(files)) publicBundles.push({ file: `${base}/${file}`, body });
  return record;
}
const lab = await bundle("demo", "audit-lab", {
  "index.html": '<!doctype html><script type="module" src="./demo.mjs"></script>',
  "demo.mjs": "export const publicLab = true;\n",
  "fallback.html": "<p>Public lab fallback.</p>",
}, "index.html");
const figure = await bundle("figure", "audit-figure", {
  "main.mjs": "export function mount(root) { root.textContent = 'Public chart'; }\n",
  "fallback.html": "<p>Public figure fallback.</p>",
}, "main.mjs");
({ draft, etag } = await drafts.save(draft.postId, { body: [
  "Public audit prose.", `![Public diagram](attachment://${image.id})`,
  `::tex[${tex.id}]`, `::demo[${lab.id}]`, `::figure[${figure.id}]`,
].join("\n\n") }, etag));
const preview = await createPreviewer(store, {
  uploads, interactives: bundles, signGet: async () => signedUrl,
}).render(draft);
assert.ok(preview.html.includes(privateValues.signature), "preview never held a temporary URL");
assert.ok(!preview.diagnostics.some((item) => item.level === "error"));
await publisher.publish(draft);
const latex = await drafts.create({
  title: "Public TeX audit", slug: "public-tex-audit", date: "2026-09-12",
  format: "latex", body: "\\section{Public TeX heading}\nPublic TeX prose.",
});
await publisher.publish(latex.draft);

// These exist beside published content, including a newer private edit of a
// live post. The build must follow the index, never the current draft pointer.
await drafts.save(draft.postId, { body: privateValues.newerDraft }, etag);
await drafts.create({ title: "Private audit draft", date: "2026-09-13", body: privateValues.unpublished });
await store.put(keys.session("audit-session"), JSON.stringify({ token: privateValues.session }));
await store.put(keys.upload(draft.postId, "u_0000000000000001", "file"), privateValues.upload);
await store.put(`${keys.draftPrefix(draft.postId)}preview.html`, preview.html);
const revisionKey = keys.publishedRevision(draft.postId, draft.revisionId);
const revision = await store.getJson(revisionKey);
await store.put(revisionKey, JSON.stringify({ ...revision.data, privateNote: privateValues.metadata }));

const stored = (await store.listAll()).map(({ key }) => key);
for (const marker of ["unpublished", "newerDraft", "session", "upload", "metadata", "signature"]) {
  let present = false;
  for (const key of stored) {
    if ((await store.get(key)).body.includes(Buffer.from(privateValues[marker]))) present = true;
  }
  assert.ok(present, `${marker} was never stored; its absence from the build would prove nothing`);
}
fs.writeFileSync(process.env.BUILD_AUDIT_RECORD, JSON.stringify({
  privateValues, publicBundles,
  posts: [draft, latex.draft].map(({ slug, postId, revisionId }) => ({ slug, postId, revisionId })),
}));
