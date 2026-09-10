// GET /login — public sign-in page.
//
// Redirects an owner who already has a session, so returning to the tab does
// not present a pointless password box.
import { loginPage, pageHeaders } from "../lib/server/pages.mjs";
import { route, readCookie } from "../lib/server/http.mjs";

export default route(async ({ req, res, sessions }) => {
  const token = readCookie(req);
  if (token && await sessions.verify(token)) {
    res.statusCode = 302;
    res.setHeader("location", "/editor/");
    res.setHeader("cache-control", "no-store");
    return res.end();
  }

  for (const [key, value] of Object.entries(pageHeaders())) res.setHeader(key, value);
  return res.status(200).end(loginPage());
}, { methods: ["GET"], auth: false });
