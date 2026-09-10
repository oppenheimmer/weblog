// POST /api/auth/login/ — verify the password and mint a session.
import { verifyPassword } from "../../lib/server/passwords.mjs";
import { ABSOLUTE_LIFETIME_MS, csrfToken } from "../../lib/server/sessions.mjs";
import {
  route, readJsonBody, sendJson, sendError, serializeCookie, clientAddress,
} from "../../lib/server/http.mjs";

export default route(async ({ req, res, requestId, sessions, limiter }) => {
  const client = clientAddress(req.headers) ?? "unknown";

  // Checked before the password is even read, so a locked-out caller cannot
  // keep paying for scrypt work.
  const gate = await limiter.check(client);
  if (!gate.allowed) {
    res.setHeader("retry-after", Math.ceil(gate.retryAfterMs / 1000));
    return sendError(res, 429, "rate_limited",
      "Too many attempts. Try again shortly.", { requestId });
  }

  const body = await readJsonBody(req);
  const password = typeof body?.password === "string" ? body.password : "";

  const stored = process.env.ADMIN_PASSWORD_HASH;
  const ok = await verifyPassword(password, stored);

  if (!ok) {
    await limiter.recordFailure(client);
    // One message for every failure mode — wrong password, no password, and a
    // server with no hash configured are indistinguishable to whoever is
    // guessing.
    return sendError(res, 401, "invalid_credentials", "Incorrect password.", { requestId });
  }

  // A fresh session on every login: nothing from before it is carried forward.
  const { token, session } = await sessions.create();
  res.setHeader("set-cookie", serializeCookie(token, { maxAge: ABSOLUTE_LIFETIME_MS }));
  return sendJson(res, 200, {
    ok: true,
    csrfToken: csrfToken(session),
    expiresAt: session.expiresAt,
  });
}, { methods: ["POST"], auth: false, csrf: false });
