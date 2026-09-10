// Deployment probe (CLAUDE.md Step 0).
//
// Answers three questions that the rest of Slice 1 is built on, and that are
// cheaper to answer now than to discover after six routes exist:
//
//   1. Does Vercel serve api/ functions alongside a static outputDirectory?
//   2. Do imports from lib/ — outside api/ — get bundled and resolve?
//   3. Do the npm dependencies the server modules need come along?
//
// Reports presence, never values. Trimmed down once it has done its job.
import { RESERVED_SLUGS } from "../lib/content.mjs";
import { hasR2Config } from "../lib/server/config.mjs";
import { createStore } from "../lib/server/r2.mjs";

/** Length and character class, never the value. */
function describeShape(value) {
  if (!value) return "missing";
  if (/^\d+$/.test(value)) return `integer (${value.length} chars)`;
  return `non-integer (${value.length} chars, starts "${value.slice(0, 4)}")`;
}

export default async function handler(req, res) {
  const checks = {
    ok: true,
    node: process.version,
    // Proves a plain lib/ import resolved.
    libContent: RESERVED_SLUGS.size,
    // Proves a lib/server import resolved and can read the environment.
    r2Configured: hasR2Config(),
    // Proves the aws-sdk dependency was bundled, without touching the network.
    sdkLoaded: typeof createStore === "function",
    authConfigured: Boolean(process.env.ADMIN_PASSWORD_HASH),
    // Shape only — enough to spot a variable holding something unintended.
    authVersionShape: describeShape(process.env.AUTH_VERSION),
    prefix: process.env.R2_PREFIX || "(default)",
  };

  // Read-only reachability check: proves the function can actually talk to R2
  // with the production credentials. No writes, so it is safe to hit repeatedly.
  if (checks.r2Configured) {
    try {
      const store = createStore();
      const page = await store.list("", { limit: 1 });
      checks.r2Reachable = true;
      checks.r2HasObjects = page.keys.length > 0;
    } catch (err) {
      checks.r2Reachable = false;
      checks.r2Error = String(err?.name || err?.message || err).slice(0, 120);
    }
  }

  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.status(200).end(JSON.stringify(checks, null, 2));
}
