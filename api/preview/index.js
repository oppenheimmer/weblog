// /api/preview/ — render a draft exactly as it would publish (CLAUDE.md Step 5),
// and serve the unpublished bundles a Run preview executes (§3.6).
//
//   POST /api/preview/                      render the fields on screen
//   GET  /api/preview/run/<grant>/<file>    one file of a granted bundle
//
// A render takes the fields on screen, saved or not, and returns HTML for the
// editor's sandboxed frame plus diagnostics. Writes nothing. Run files share
// this function rather than taking a route of their own, which keeps the
// function count at 11; `vercel.json` rewrites their addresses here.
import { createPreviewer, PreviewError } from "../../lib/server/preview.mjs";
import { createRunFiles, readRunGrant, runTarget, RUN_HEADERS } from "../../lib/server/run-grants.mjs";
import { route, readJsonBody, sendJson, sendError } from "../../lib/server/http.mjs";

// `signGet` comes from the context only in tests, where there is no real client
// to sign with; in production the store signs.
const render = route(async ({ req, res, requestId, store, annotate, signGet, runSecret }) => {
  const previewer = createPreviewer(store, { ...(signGet ? { signGet } : {}), runSecret });
  try {
    const body = await readJsonBody(req);
    annotate({ postId: body?.postId });
    return sendJson(res, 200, await previewer.render(body));
  } catch (err) {
    if (err instanceof PreviewError) {
      return sendError(res, err.status, err.code, err.message, {
        fields: err.field ? { [err.field]: err.message } : undefined,
        requestId,
      });
    }
    throw err;
  }
}, { methods: ["POST"] });

// No session: a sandboxed run frame's requests carry no cookie, so the grant
// is the permission (lib/server/run-grants.mjs). Reads only.
const run = route(async ({ req, res, requestId, store, annotate, runSecret }) => {
  const target = runTarget(req);
  const granted = target && readRunGrant(target.grant, { secret: runSecret });
  if (!granted) {
    return sendError(res, 404, "not_found", "This run link has expired. Run the preview again.", { requestId });
  }
  annotate({
    postId: granted.postId, interactiveId: granted.interactiveId, bundleRevisionId: granted.revisionId,
  });
  const found = await createRunFiles(store).read(granted, target.file);
  if (found.status !== 200) {
    return sendError(res, found.status, found.status === 413 ? "file_too_large" : "not_found",
      found.status === 413 ? "This file is too large to run in preview." : "No such file in this interactive.",
      { requestId });
  }
  for (const [key, value] of Object.entries(RUN_HEADERS)) res.setHeader(key, value);
  res.setHeader("content-type", found.type);
  res.status(200).end(found.body);
}, { methods: ["GET"], auth: false });

export default function preview(req, res) {
  return req.method === "GET" || req.method === "HEAD" ? run(req, res) : render(req, res);
}
