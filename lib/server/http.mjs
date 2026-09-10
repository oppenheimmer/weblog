// Request plumbing shared by every api/ route (CLAUDE.md §4.3, Step 3).
//
// The guards live here rather than in each handler so that adding a route
// cannot accidentally omit one. A route opts *out* explicitly; it never has to
// remember to opt in.
import crypto from "node:crypto";

import { createStore } from "./r2.mjs";
import { createSessionStore, csrfToken, verifyCsrf } from "./sessions.mjs";
import { createRateLimiter, clientAddress } from "./rate-limit.mjs";

// A draft body may be ~1 MB; JSON escaping inflates that. Still far below
// Vercel's 4.5 MB request cap, which is a hard ceiling we never want to meet.
export const MAX_BODY_BYTES = 2_000_000;

const PROD_COOKIE = "__Host-weblog_session";
// __Host- requires Secure, which requires HTTPS. Local http:// development
// therefore needs a separate, clearly non-production name.
const DEV_COOKIE = "weblog_session_dev";

export const isProduction = () =>
  process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

export const cookieName = () => (isProduction() ? PROD_COOKIE : DEV_COOKIE);

export function serializeCookie(value, { maxAge, expire = false } = {}) {
  const parts = [
    `${cookieName()}=${expire ? "" : value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  // No Domain attribute, deliberately: host-only cookies are not sent to
  // sibling subdomains.
  if (isProduction()) parts.push("Secure");
  parts.push(expire ? "Max-Age=0" : `Max-Age=${Math.floor(maxAge / 1000)}`);
  return parts.join("; ");
}

export function readCookie(req) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === cookieName()) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return null;
}

// ---------------------------------------------------------------- responses

export const newRequestId = () => crypto.randomBytes(8).toString("hex");

export function sendJson(res, status, payload, { headers = {} } = {}) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Authenticated responses must never be cached; applying it everywhere is
  // simpler than deciding per route and failing open once.
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.status(status).end(JSON.stringify(payload));
}

/** Structured errors: `{ code, message, fields?, requestId }`. Never a stack. */
export function sendError(res, status, code, message, { fields, requestId = newRequestId() } = {}) {
  sendJson(res, status, { code, message, ...(fields ? { fields } : {}), requestId });
  return { code, requestId };
}

// ---------------------------------------------------------------- origin

/**
 * Allowed origins for state-changing requests.
 *
 * Exact matches only — no suffix tests, which are the classic way this check
 * gets defeated (`evil-blog.souravmishra.net.attacker.com`).
 */
export function allowedOrigins() {
  const configured = [process.env.SITE_URL, process.env.EDITOR_ORIGIN]
    .filter(Boolean)
    .map((value) => value.replace(/\/$/, ""));
  if (configured.length) return configured;
  if (isProduction()) return ["https://blog.souravmishra.net"];
  return ["http://localhost:3000", "http://localhost:4321"];
}

/**
 * Same-origin check for anything that mutates state.
 *
 * A missing Origin header is refused rather than allowed: browsers send it on
 * every cross-origin request and on same-origin non-GET requests, so its
 * absence on a POST means something other than a normal browser.
 */
export function checkOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return { ok: false, reason: "missing Origin header" };
  if (!allowedOrigins().includes(origin)) return { ok: false, reason: "origin not allowed" };
  return { ok: true };
}

// ---------------------------------------------------------------- body

/** Read and parse a JSON body, refusing anything oversized. */
export async function readJsonBody(req) {
  const declared = Number(req.headers?.["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    const err = new Error("Request body too large");
    err.status = 413;
    throw err;
  }

  // Vercel's Node runtime may have parsed the body already.
  if (req.body !== undefined && req.body !== null && typeof req.body === "object") {
    return req.body;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error("Request body too large");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!total) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Body is not valid JSON");
    err.status = 400;
    throw err;
  }
}

// ---------------------------------------------------------------- context

let cached;

/** Shared, lazily-built server context. Reused across warm invocations. */
export function context() {
  if (cached) return cached;
  const store = createStore();
  cached = {
    store,
    sessions: createSessionStore(store, { authVersion: Number(process.env.AUTH_VERSION ?? 1) }),
    limiter: createRateLimiter(store, { secret: process.env.RATE_LIMIT_HASH_SECRET }),
  };
  return cached;
}

/** Test seam, so a suite can install a context over a fake bucket. */
export function setContext(next) {
  cached = next;
}

// ---------------------------------------------------------------- guard

/**
 * Wrap a handler with method, origin, session and CSRF checks.
 *
 * Defaults are the safe ones: authentication required, and CSRF enforced on
 * every method that is not a read.
 */
export function route(handler, {
  methods = ["GET"],
  auth = true,
  csrf = true,
} = {}) {
  return async function wrapped(req, res) {
    const requestId = newRequestId();
    try {
      if (!methods.includes(req.method)) {
        res.setHeader("allow", methods.join(", "));
        return sendError(res, 405, "method_not_allowed", `${req.method} is not allowed here.`, { requestId });
      }

      const mutating = req.method !== "GET" && req.method !== "HEAD";
      if (mutating) {
        const origin = checkOrigin(req);
        if (!origin.ok) {
          return sendError(res, 403, "bad_origin", "Request origin is not allowed.", { requestId });
        }
      }

      let session = null;
      if (auth) {
        const token = readCookie(req);
        session = token ? await context().sessions.verify(token) : null;
        if (!session) {
          return sendError(res, 401, "unauthenticated", "Sign in to continue.", { requestId });
        }
        if (mutating && csrf) {
          const presented = req.headers?.["x-csrf-token"];
          if (!verifyCsrf(session, presented)) {
            return sendError(res, 403, "bad_csrf", "Missing or invalid CSRF token.", { requestId });
          }
        }
      }

      return await handler({ req, res, session, requestId, ...context() });
    } catch (err) {
      const status = err?.status ?? 500;
      // Client mistakes may be described; anything else is reported as an
      // opaque failure so an internal message cannot leak through an error path.
      const message = status >= 400 && status < 500
        ? err.message
        : "Something went wrong. The failure was logged.";
      if (status >= 500) {
        console.error(`[${requestId}] ${err?.stack || err}`);
      }
      return sendError(res, status, err?.code ?? "error", message, {
        fields: err?.field ? { [err.field]: err.message } : undefined,
        requestId,
      });
    }
  };
}

export { csrfToken, clientAddress };
