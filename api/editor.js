// GET /editor — the editor page, returned only to an authenticated owner.
//
// A function rather than a static file, deliberately: anything in dist/ is
// public, and the editor markup must not be (CLAUDE.md Step 2).
import { editorPage, pageHeaders } from "../lib/server/pages.mjs";
import { route, readCookie } from "../lib/server/http.mjs";

export default route(async ({ req, res, sessions }) => {
  const token = readCookie(req);
  const session = token ? await sessions.verify(token) : null;

  if (!session) {
    // A browser navigation deserves a redirect, not a JSON 401.
    res.statusCode = 302;
    res.setHeader("location", "/login/");
    res.setHeader("cache-control", "no-store");
    return res.end();
  }

  // The editor uploads straight to R2 and previews in a sandboxed frame, so its
  // CSP admits exactly what those two features need.
  for (const [key, value] of Object.entries(pageHeaders({ uploads: true, preview: true }))) res.setHeader(key, value);
  return res.status(200).end(editorPage());
}, { methods: ["GET"], auth: false });
