// /api/uploads/ — a draft's attachments and interactive bundles
// (CLAUDE.md §4.3, Step 4, §3.6).
//
//   GET    /api/uploads/?postId=<id>                      list verified attachments
//   GET    /api/uploads/?postId=<id>&kind=interactive     list verified bundles
//   POST   /api/uploads/  { action: "sign", postId, name, size, type, kind }
//   POST   /api/uploads/  { action: "complete", postId, uploadId }
//   POST   /api/uploads/  { action: "begin-bundle", postId, manifest, interactiveId? }
//   POST   /api/uploads/  { action: "complete-bundle", postId, uploadId }
//   POST   /api/uploads/  { action: "promote-bundle", postId, interactiveId, revisionId }
//   DELETE /api/uploads/?postId=<id>&attachmentId=<id>    remove from the draft
//   DELETE /api/uploads/?postId=<id>&interactiveId=<id>   remove a bundle
//
// One function rather than the plan's separate sign and complete routes, on
// purpose: §4.3 permits consolidation, and every function counts against the
// Vercel plan's limit. Bundles arrive here for the same reason attachments do,
// and are folded in rather than given a route of their own, which keeps the
// count at 11. Bytes never arrive here — the client PUTs them to R2 on the
// signed URLs, because a function request is capped at 4.5 MB.
import { createUploads, UploadError } from "../../lib/server/uploads.mjs";
import { createInteractives, BundleError } from "../../lib/server/interactives.mjs";
import { route, readJsonBody, sendJson, sendError } from "../../lib/server/http.mjs";

const param = (req, name) =>
  req.query?.[name] ?? new URL(req.url, "http://x").searchParams.get(name);

// `signPut` comes from the context only in tests, where there is no real
// client to sign with; in production the store signs.
export default route(async ({ req, res, requestId, store, annotate, signPut }) => {
  const uploads = createUploads(store, signPut ? { signPut } : {});
  const interactives = createInteractives(store, signPut ? { signPut } : {});

  try {
    annotate({ postId: param(req, "postId") });
    if (req.method === "GET") {
      if (param(req, "kind") === "interactive") {
        return sendJson(res, 200, { interactives: await interactives.list(param(req, "postId")) });
      }
      return sendJson(res, 200, { attachments: await uploads.list(param(req, "postId")) });
    }
    if (req.method === "DELETE") {
      const interactiveId = param(req, "interactiveId");
      annotate({ action: "remove", interactiveId, attachmentId: param(req, "attachmentId") });
      if (interactiveId) {
        return sendJson(res, 200, await interactives.remove(param(req, "postId"), interactiveId));
      }
      return sendJson(res, 200, await uploads.remove(param(req, "postId"), param(req, "attachmentId")));
    }

    const body = await readJsonBody(req);
    annotate({ action: body?.action, postId: body?.postId, uploadId: body?.uploadId });
    if (body?.action === "sign") {
      const signed = await uploads.sign(body);
      annotate({ uploadId: signed.uploadId, attachmentId: signed.attachmentId });
      return sendJson(res, 200, signed);
    }
    if (body?.action === "complete") {
      const attachment = await uploads.complete(body);
      annotate({ attachmentId: attachment.id });
      return sendJson(res, 200, { attachment });
    }
    if (body?.action === "begin-bundle") {
      const agreed = await interactives.begin(body);
      annotate({ interactiveId: agreed.interactiveId, bundleRevisionId: agreed.revisionId, uploadId: agreed.uploadId });
      return sendJson(res, 200, agreed);
    }
    if (body?.action === "complete-bundle") {
      const interactive = await interactives.complete(body);
      annotate({ interactiveId: interactive.id, bundleRevisionId: interactive.revisionId });
      return sendJson(res, 200, { interactive });
    }
    if (body?.action === "promote-bundle") {
      annotate({ interactiveId: body.interactiveId, bundleRevisionId: body.revisionId });
      return sendJson(res, 200, { interactive: await interactives.promote(body) });
    }
    return sendError(res, 400, "unknown_action", "Say whether to sign or complete an upload.", { requestId });
  } catch (err) {
    if (err instanceof UploadError || err instanceof BundleError) {
      return sendError(res, err.status, err.code, err.message, {
        fields: err.field ? { [err.field]: err.message } : undefined,
        requestId,
      });
    }
    throw err;
  }
}, { methods: ["GET", "POST", "DELETE"] });
