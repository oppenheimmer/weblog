// POST /api/preview/ — render a draft exactly as it would publish (CLAUDE.md Step 5).
//
// Takes the fields on screen, saved or not, and returns HTML for the editor's
// sandboxed frame plus diagnostics. Writes nothing.
import { createPreviewer, PreviewError } from "../../lib/server/preview.mjs";
import { route, readJsonBody, sendJson, sendError } from "../../lib/server/http.mjs";

// `signGet` comes from the context only in tests, where there is no real client
// to sign with; in production the store signs.
export default route(async ({ req, res, requestId, store, annotate, signGet }) => {
  const previewer = createPreviewer(store, signGet ? { signGet } : {});
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
