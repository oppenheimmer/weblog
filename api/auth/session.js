// GET /api/auth/session/ — authentication state and a CSRF token.
//
// Deliberately unauthenticated: the editor calls it on load to discover whether
// it has a session at all. It reveals only whether the caller's own cookie is
// valid, and returns a CSRF token only when it is.
import { csrfToken } from "../../lib/server/sessions.mjs";
import { route, sendJson, readCookie } from "../../lib/server/http.mjs";

export default route(async ({ req, res, sessions }) => {
  const token = readCookie(req);
  const session = token ? await sessions.verify(token) : null;
  if (!session) return sendJson(res, 200, { authenticated: false });

  return sendJson(res, 200, {
    authenticated: true,
    csrfToken: csrfToken(session),
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
  });
}, { methods: ["GET"], auth: false });
