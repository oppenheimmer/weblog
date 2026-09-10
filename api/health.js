// GET /api/health/ — liveness only.
//
// This began as a deployment probe (CLAUDE.md Step 0) and answered what it was
// for: api/ functions are served alongside the static outputDirectory, imports
// from lib/ resolve once bundled, npm dependencies come along, Node is 24.x,
// and the function can reach R2 with production credentials. Those findings are
// recorded in the plan; the diagnostics are gone because this route is public
// and had no reason to keep reporting which variables are configured.
export default function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.status(200).end(JSON.stringify({ ok: true }));
}
