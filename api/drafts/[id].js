// GET    /api/drafts/<id>/ — fetch a draft and its ETag
// PUT    /api/drafts/<id>/ — save conditionally; 409 when stale
// DELETE /api/drafts/<id>/ — discard a draft and its revisions
import { createDraftStore } from "../../lib/server/drafts.mjs";
import { ConflictError } from "../../lib/server/r2.mjs";
import { route, readJsonBody, sendJson, sendError } from "../../lib/server/http.mjs";

export default route(async ({ req, res, requestId, store }) => {
  const drafts = createDraftStore(store);
  const postId = req.query?.id
    ?? new URL(req.url, "http://x").pathname.split("/").filter(Boolean).pop();

  if (req.method === "GET") {
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
    const saved = await drafts.save(postId, body ?? {}, etag);
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
