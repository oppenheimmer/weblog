// POST /api/publish/ — freeze the current draft and trigger a rebuild.
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createPublisher, PublishError } from "../lib/server/publish.mjs";
import { route, readJsonBody, sendJson, sendError } from "../lib/server/http.mjs";

export default route(async ({ req, res, requestId, store }) => {
  if (process.env.PUBLISH_ENABLED === "false") {
    return sendError(res, 403, "publish_disabled",
      "Publishing is disabled in this environment.", { requestId });
  }

  const body = await readJsonBody(req);
  const postId = body?.postId;
  if (!postId) {
    return sendError(res, 400, "post_required", "Which post should be published?", { requestId });
  }

  const found = await createDraftStore(store).get(postId);
  if (!found) return sendError(res, 404, "not_found", "No such draft.", { requestId });

  try {
    const job = await createPublisher(store).publish(found.draft, {
      // Ties the request to this exact revision, so a double-click publishes
      // once rather than twice.
      idempotencyKey: body.idempotencyKey || `${postId}:${found.draft.revisionId}`,
    });
    return sendJson(res, 200, { job, url: `/${found.draft.slug}/` });
  } catch (err) {
    if (err instanceof PublishError) {
      return sendError(res, err.status, err.code, err.message, {
        fields: err.field ? { [err.field]: err.message } : undefined, requestId,
      });
    }
    throw err;
  }
}, { methods: ["POST"] });
