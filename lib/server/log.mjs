// Structured request logs (CLAUDE.md Step 9).
//
// One JSON line per request, written to stdout, where Vercel collects runtime
// logs. What goes in is decided by shape, not by care:
//
//   * the route itself contributes method, path (never the query string, and
//     never a Run preview grant), status, duration, and the request, commit
//     and deployment ids;
//   * a handler may add fields, but only the ones named below, and only with
//     values matching their shape — ids, action names, outcome and refusal
//     codes. Anything else is dropped, so a password, cookie, token, signed URL
//     or draft text cannot reach a line even by mistake;
//   * a refusal is logged by its code, never its message, because messages can
//     quote what an author wrote;
//   * a server failure carries its error and stack, which are this code's own.
//
// Hobby keeps runtime logs for one hour. That is accepted rather than worked
// around: the durable record of what changed is already in R2 — publication
// jobs, the build's failure record — and these lines are for the hour after
// something goes wrong.

const FIELDS = {
  action: /^[a-z][a-z-]{0,23}$/,
  outcome: /^[a-z][a-z_]{0,31}$/,
  code: /^[a-z][a-z_]{0,39}$/,
  postId: /^p_[0-9a-f]{16}$/,
  revisionId: /^r_[0-9a-z_]{1,64}$/,
  jobId: /^j_[0-9a-f]{16}$/,
  uploadId: /^u_[0-9a-f]{16}$/,
  attachmentId: /^a_[0-9a-f]{16}$/,
  interactiveId: /^i_[0-9a-f]{16}$/,
  bundleRevisionId: /^iv_[0-9a-f]{16}$/,
};

/** Keep the fields this log knows, with values of the shape it expects. Drop the rest. */
export function safeFields(fields = {}) {
  const kept = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (FIELDS[key] && typeof value === "string" && FIELDS[key].test(value)) kept[key] = value;
  }
  return kept;
}

const env = (name, pattern) => {
  const value = process.env[name];
  return typeof value === "string" && pattern.test(value) ? value : null;
};

/** The line for one request. */
export function requestRecord({ requestId, method, url, status, ms, fields, error, code }) {
  let path = null;
  try {
    path = new URL(String(url ?? "/"), "http://local").pathname
      // A Run preview address carries its grant, a bearer capability, in the
      // path itself (lib/server/run-grants.mjs). The file name stays.
      .replace(/^(\/api\/preview\/run\/)[^/]+/, "$1-");
  } catch {
    path = null;
  }
  const failed = status >= 500;
  return {
    t: new Date().toISOString(),
    level: failed ? "error" : status >= 400 ? "warn" : "info",
    event: "request",
    requestId,
    method,
    path,
    status,
    ms,
    ...safeFields({ ...fields, ...(code ? { code } : {}) }),
    commit: env("VERCEL_GIT_COMMIT_SHA", /^[0-9a-f]{7,40}$/)?.slice(0, 12) ?? null,
    deployment: env("VERCEL_DEPLOYMENT_ID", /^dpl_[A-Za-z0-9]{1,64}$/),
    ...(failed && error ? { error: { name: error.name, message: String(error.message), stack: error.stack } } : {}),
  };
}

/** Write a line. Never throws: a log that cannot be written must not fail a request. */
export function writeLog(record, write = (line) => console.log(line)) {
  try {
    write(JSON.stringify(record));
  } catch {
    // Nowhere left to say it.
  }
}
