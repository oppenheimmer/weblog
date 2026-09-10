// GET  /api/drafts/  — list draft summaries
// POST /api/drafts/  — create a draft
import { createDraftStore } from "../../lib/server/drafts.mjs";
import { route, readJsonBody, sendJson } from "../../lib/server/http.mjs";

export default route(async ({ req, res, store }) => {
  const drafts = createDraftStore(store);

  if (req.method === "GET") {
    return sendJson(res, 200, { drafts: await drafts.list() });
  }

  const body = await readJsonBody(req);
  const { draft, etag } = await drafts.create(body ?? {});
  // The ETag is the client's token for its next save; without it the save is
  // refused rather than allowed to clobber.
  res.setHeader("etag", etag);
  return sendJson(res, 201, { draft, etag });
}, { methods: ["GET", "POST"] });
