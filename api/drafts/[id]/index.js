// GET    /api/drafts/<id>/ — fetch a draft and its ETag
//
// Nested as [id]/index.js rather than [id].js on purpose: vercel.json sets
// trailingSlash, so requests arrive as /api/drafts/<id>/ and a bare [id].js
// does not match that — it 404s. This mirrors how the static site emits
// <slug>/index.html, where the trailing slash is the natural form.
// PUT    /api/drafts/<id>/ — save conditionally; 409 when stale
// DELETE /api/drafts/<id>/ — discard a draft and its revisions
import { createDraftStore } from "../../../lib/server/drafts.mjs";
import { ConflictError } from "../../../lib/server/r2.mjs";
import { route, readJsonBody, sendJson, sendError } from "../../../lib/server/http.mjs";
import { postExportManifest, exportFileChunk } from "../../../lib/server/export.mjs";

export default route(async ({ req, res, requestId, store, annotate }) => {
  const drafts = createDraftStore(store);
  const postId = req.query?.id
    ?? new URL(req.url, "http://x").pathname.split("/").filter(Boolean).pop();
  annotate({ postId });

  if (req.method === "GET") {
    const query = new URL(req.url, "http://x").searchParams;
    if (query.get("action") === "checkpoints") return sendJson(res, 200, { checkpoints: await drafts.checkpoints(postId) });
    if (query.has("checkpoint")) return sendJson(res, 200, await drafts.getCheckpoint(postId, query.get("checkpoint")));
    if (query.get("action") === "export") return sendJson(res, 200, await postExportManifest(store, postId, { etag: req.headers?.["if-match"] }));
    if (query.get("action") === "export-file") {
      const bytes = await exportFileChunk(store, postId, query.get("file"), Number(query.get("offset") ?? 0));
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="export-part.bin"');
      return res.end(bytes);
    }
    if (query.get("action") === "history") {
      return sendJson(res, 200, { revisions: await drafts.history(postId) });
    }
    if (query.has("revision")) {
      const draft = await drafts.getRevision(postId, query.get("revision"));
      if (!draft) return sendError(res, 404, "not_found", "That draft revision is no longer retained.", { requestId });
      return sendJson(res, 200, { draft });
    }
    const found = await drafts.get(postId);
    if (!found) return sendError(res, 404, "not_found", "No such draft.", { requestId });
    res.setHeader("etag", found.etag);
    return sendJson(res, 200, found);
  }

  if (req.method === "DELETE") {
    await drafts.remove(postId);
    return sendJson(res, 200, { ok: true });
  }

  const body = await readJsonBody(req);
  // If-Match is the concurrency contract. Accepting a header or a body field
  // keeps a plain fetch() call simple without weakening it: one must be present.
  const etag = req.headers?.["if-match"] ?? body?.etag;
  if (!etag) {
    return sendError(res, 428, "etag_required",
      "Include the ETag from the read this edit is based on.", { requestId });
  }

  try {
    if (body?.action === "checkpoint") {
      return sendJson(res, 201, { checkpoint: await drafts.checkpoint(postId, body.name, etag) });
    }
    if (body?.action === "remove-checkpoint") {
      await drafts.removeCheckpoint(postId, body.checkpointId);
      return sendJson(res, 200, { ok: true });
    }
    const saved = body?.action === "restore"
      ? await drafts.restore(postId, body.revisionId, etag)
      : body?.action === "restore-checkpoint"
        ? await drafts.restoreCheckpoint(postId, body.checkpointId, etag)
        : await drafts.save(postId, body ?? {}, etag);
    annotate({ action: "save", revisionId: saved.draft.revisionId });
    res.setHeader("etag", saved.etag);
    return sendJson(res, 200, saved);
  } catch (err) {
    if (err instanceof ConflictError) {
      // Hand back what is actually stored, so the editor can show a real diff
      // rather than telling the author their work is simply gone.
      const current = await drafts.get(postId);
      return sendJson(res, 409, {
        code: "conflict",
        message: "This draft changed elsewhere since you loaded it.",
        requestId,
        current: current?.draft ?? null,
        etag: current?.etag ?? null,
      });
    }
    throw err;
  }
}, { methods: ["GET", "PUT", "DELETE"] });
