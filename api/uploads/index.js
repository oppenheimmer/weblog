// /api/uploads/ — a draft's attachments (CLAUDE.md §4.3, Step 4).
//
//   GET    /api/uploads/?postId=<id>                      list verified attachments
//   POST   /api/uploads/  { action: "sign", postId, name, size, type, kind }
//   POST   /api/uploads/  { action: "complete", postId, uploadId }
//   DELETE /api/uploads/?postId=<id>&attachmentId=<id>    remove from the draft
//
// One function rather than the plan's separate sign and complete routes, on
// purpose: §4.3 permits consolidation, and every function counts against the
// Vercel plan's limit. Bytes never arrive here — the browser PUTs them to R2 on
// the signed URL, because a function request is capped at 4.5 MB.
import { createUploads, UploadError } from "../../lib/server/uploads.mjs";
import { route, readJsonBody, sendJson, sendError } from "../../lib/server/http.mjs";

const param = (req, name) =>
  req.query?.[name] ?? new URL(req.url, "http://x").searchParams.get(name);

// `signPut` comes from the context only in tests, where there is no real
// client to sign with; in production the store signs.
export default route(async ({ req, res, requestId, store, signPut }) => {
  const uploads = createUploads(store, signPut ? { signPut } : {});

  try {
    if (req.method === "GET") {
      return sendJson(res, 200, { attachments: await uploads.list(param(req, "postId")) });
    }
    if (req.method === "DELETE") {
      return sendJson(res, 200, await uploads.remove(param(req, "postId"), param(req, "attachmentId")));
    }

    const body = await readJsonBody(req);
    if (body?.action === "sign") {
      return sendJson(res, 200, await uploads.sign(body));
    }
    if (body?.action === "complete") {
      return sendJson(res, 200, { attachment: await uploads.complete(body) });
    }
    return sendError(res, 400, "unknown_action", "Say whether to sign or complete an upload.", { requestId });
  } catch (err) {
    if (err instanceof UploadError) {
      return sendError(res, err.status, err.code, err.message, {
        fields: err.field ? { [err.field]: err.message } : undefined,
        requestId,
      });
    }
    throw err;
  }
}, { methods: ["GET", "POST", "DELETE"] });
