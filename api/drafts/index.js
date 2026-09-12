// GET  /api/drafts/  — list draft summaries
// POST /api/drafts/  — create a draft, or branch one from a published revision
import { createDraftStore } from "../../lib/server/drafts.mjs";
import { route, readJsonBody, sendJson } from "../../lib/server/http.mjs";

export default route(async ({ req, res, store, annotate }) => {
  const drafts = createDraftStore(store);

  if (req.method === "GET") {
    return sendJson(res, 200, { drafts: await drafts.list() });
  }

  const body = await readJsonBody(req);
  if (body?.action === "branch") {
    annotate({ action: "branch", postId: body.postId, revisionId: body.revisionId });
    const result = await drafts.branchPublished(body.postId, body.revisionId);
    res.setHeader("etag", result.etag);
    return sendJson(res, result.created ? 201 : 200, result);
  }
  const { draft, etag } = await drafts.create(body ?? {});
  annotate({ action: "create", postId: draft.postId, revisionId: draft.revisionId });
  // The ETag is the client's token for its next save; without it the save is
  // refused rather than allowed to clobber.
  res.setHeader("etag", etag);
  return sendJson(res, 201, { draft, etag });
}, { methods: ["GET", "POST"] });
