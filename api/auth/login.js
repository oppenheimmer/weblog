// POST /api/auth/login/ — verify the password and mint a session.
import { verifyPassword } from "../../lib/server/passwords.mjs";
import { ABSOLUTE_LIFETIME_MS, csrfToken } from "../../lib/server/sessions.mjs";
import { DEVICE_COOKIE_MAX_AGE_MS } from "../../lib/server/rate-limit.mjs";
import {
  route, readJsonBody, sendJson, sendError, serializeCookie, readCookie, deviceCookieName, clientAddress,
} from "../../lib/server/http.mjs";

export default route(async ({ req, res, requestId, sessions, limiter, annotate }) => {
  const client = clientAddress(req.headers) ?? "unknown";
  // A browser that signed in before has a budget of its own, which failed
  // attempts from anywhere else cannot spend (lib/server/rate-limit.mjs).
  const device = limiter.identifyDevice(readCookie(req, deviceCookieName()));

  // Admission is the count, taken before the body is read or scrypt runs, so a
  // burst cannot all slip under a limit it has not yet been charged against.
  const admission = await limiter.admit({ client, device });
  if (!admission.allowed) {
    annotate({ outcome: "limited" });
    res.setHeader("retry-after", Math.ceil(admission.retryAfterMs / 1000));
    return sendError(res, 429, "rate_limited",
      "Too many attempts. Try again shortly.", { requestId });
  }

  const body = await readJsonBody(req);
  const password = typeof body?.password === "string" ? body.password : "";

  const stored = process.env.ADMIN_PASSWORD_HASH;
  const ok = await verifyPassword(password, stored);

  if (!ok) {
    annotate({ outcome: "refused" });
    // The attempt stays counted. One message for every failure mode — wrong
    // password, no password, and a server with no hash configured are
    // indistinguishable to whoever is guessing.
    return sendError(res, 401, "invalid_credentials", "Incorrect password.", { requestId });
  }

  annotate({ outcome: "signed_in" });
  // A correct password gives its attempt back, so signing in costs nothing.
  await limiter.release(admission);

  // A fresh session on every login: nothing from before it is carried forward.
  const { token, session } = await sessions.create();
  const remembered = limiter.deviceCookie(device);
  res.setHeader("set-cookie", [
    serializeCookie(token, { maxAge: ABSOLUTE_LIFETIME_MS }),
    serializeCookie(remembered.value, { maxAge: DEVICE_COOKIE_MAX_AGE_MS, name: deviceCookieName() }),
  ]);
  return sendJson(res, 200, {
    ok: true,
    csrfToken: csrfToken(session),
    expiresAt: session.expiresAt,
  });
}, { methods: ["POST"], auth: false, csrf: false });
