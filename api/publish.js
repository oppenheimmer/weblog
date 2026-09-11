// /api/publish/ — putting posts on the site and taking them off
// (CLAUDE.md §4.3, Step 6, Step 7).
//
//   GET  /api/publish/                                             every publication, and what the site shows
//   POST /api/publish/  { postId }                                 publish the post's saved draft
//   POST /api/publish/  { action: "unpublish", postId }            take a post off the site
//   POST /api/publish/  { action: "rollback", postId, revisionId } put a stored revision on the site
//   POST /api/publish/  { action: "rebuild" }                      rebuild without changing anything
//
// One function for all of it, as with api/uploads/: every function counts
// against the Vercel plan's limit. A change answers as soon as R2 holds it;
// GET is how the editor learns when the site has caught up.
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createPublisher, PublishError } from "../lib/server/publish.mjs";
import { readSiteManifest, siteStatus } from "../lib/server/deployments.mjs";
import { route, readJsonBody, sendJson, sendError } from "../lib/server/http.mjs";

// `fireDeployHook` and `readManifest` come from the context only in tests; in
// production the real hook fires and the real site is read.
export default route(async ({ req, res, requestId, store, fireDeployHook, readManifest = readSiteManifest }) => {
  const publisher = createPublisher(store, fireDeployHook ? { fireDeployHook } : {});

  try {
    if (req.method === "GET") {
      const [publications, manifest] = await Promise.all([publisher.listPublications(), readManifest()]);
      return sendJson(res, 200, {
        site: manifest.ok
          ? { ok: true, commit: manifest.commit }
          : { ok: false, checkable: manifest.checkable, reason: manifest.reason },
        publications: publications.map((publication) => ({ ...publication, site: siteStatus(publication, manifest) })),
      });
    }

    if (process.env.PUBLISH_ENABLED === "false") {
      return sendError(res, 403, "publish_disabled",
        "Publishing is disabled in this environment.", { requestId });
    }

    const body = await readJsonBody(req);
    const action = body?.action ?? "publish";

    if (action === "rebuild") return sendJson(res, 200, await publisher.rebuild());

    const postId = body?.postId;
    if (!postId) {
      return sendError(res, 400, "post_required", "Which post?", { requestId });
    }
    if (action === "unpublish") return sendJson(res, 200, await publisher.unpublish(postId));
    if (action === "rollback") return sendJson(res, 200, await publisher.rollback(postId, body.revisionId));
    if (action !== "publish") {
      return sendError(res, 400, "unknown_action",
        "Say whether to publish, unpublish, roll back or rebuild.", { requestId });
    }

    const found = await createDraftStore(store).get(postId);
    if (!found) return sendError(res, 404, "not_found", "No such draft.", { requestId });
    const job = await publisher.publish(found.draft, {
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
}, { methods: ["GET", "POST"] });
