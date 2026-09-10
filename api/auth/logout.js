// POST /api/auth/logout/ — revoke the session and clear its cookie.
import { csrfToken } from "../../lib/server/sessions.mjs";
import {
  route, sendJson, serializeCookie, readCookie,
} from "../../lib/server/http.mjs";

export default route(async ({ req, res, sessions }) => {
  const token = readCookie(req);
  if (token) await sessions.revoke(token);
  // Cleared even if revocation failed, so the browser stops presenting a
  // credential the server may still consider live.
  res.setHeader("set-cookie", serializeCookie("", { expire: true }));
  return sendJson(res, 200, { ok: true });
}, { methods: ["POST"] });
