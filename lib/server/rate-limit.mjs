// Durable login rate limiting (CLAUDE.md Step 3).
//
// In R2 rather than memory for the same reason sessions are: serverless
// instances share nothing, so an in-memory counter would let an attacker reset
// the limit simply by being routed to a cold instance.
//
// Two limits, because they stop different things. The per-client limit stops
// someone guessing at one password; the global limit stops a distributed spray
// where no single address ever trips the first.
import crypto from "node:crypto";

import { ConflictError } from "./r2.mjs";

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_PER_CLIENT = 5;
export const MAX_GLOBAL = 50;

/**
 * Client identifiers are hashed with a server secret before becoming keys, so
 * the bucket never accumulates a plaintext list of IP addresses that visited.
 */
export function hashClient(identifier, secret) {
  if (!secret) throw new Error("RATE_LIMIT_HASH_SECRET is required");
  return crypto.createHmac("sha256", secret).update(String(identifier ?? "unknown"))
    .digest("hex").slice(0, 32);
}

/**
 * The client address, taken only from platform-set forwarding metadata.
 *
 * A browser-supplied header must never be trusted here: anyone could send
 * `X-Forwarded-For: <random>` on each attempt and never trip a per-client
 * limit. Vercel sets `x-vercel-forwarded-for` itself and strips inbound copies.
 */
export function clientAddress(headers = {}) {
  const get = (name) =>
    typeof headers.get === "function" ? headers.get(name) : headers[name];
  return get("x-vercel-forwarded-for") || get("x-real-ip") || null;
}

const windowStart = (timestamp, windowMs) => Math.floor(timestamp / windowMs) * windowMs;

export function createRateLimiter(store, {
  now = () => Date.now(),
  secret,
  windowMs = WINDOW_MS,
  maxPerClient = MAX_PER_CLIENT,
  maxGlobal = MAX_GLOBAL,
} = {}) {
  const key = (scope, id, start) => `rate-limits/${start}/${scope}-${id}.json`;

  async function bump(scope, id, limit) {
    const timestamp = now();
    const start = windowStart(timestamp, windowMs);
    const recordKey = key(scope, id, start);
    const record = await store.mutateJson(recordKey, (current) => ({
      count: (current?.count ?? 0) + 1,
      windowStart: start,
      expiresAt: start + windowMs,
    }));
    const count = record.count;
    return {
      allowed: count <= limit,
      count,
      limit,
      retryAfterMs: Math.max(0, start + windowMs - timestamp),
    };
  }

  return {
    /**
     * Record a failed attempt and report whether the caller is now locked out.
     *
     * Only failures count. A successful login does not consume budget, so
     * ordinary use never approaches the limit.
     */
    async recordFailure(identifier) {
      const clientId = hashClient(identifier, secret);
      const [client, global] = await Promise.all([
        bump("client", clientId, maxPerClient),
        bump("global", "all", maxGlobal),
      ]);
      return {
        allowed: client.allowed && global.allowed,
        client,
        global,
        retryAfterMs: Math.max(client.retryAfterMs, global.retryAfterMs),
      };
    },

    /**
     * Whether an attempt may proceed, without consuming budget.
     *
     * Fails **closed**: if storage cannot be read we cannot know how many
     * attempts have happened, and refusing a login is a far better failure than
     * silently disabling the lockout.
     */
    async check(identifier) {
      const start = windowStart(now(), windowMs);
      const clientId = hashClient(identifier, secret);
      try {
        const [client, global] = await Promise.all([
          store.getJson(key("client", clientId, start)),
          store.getJson(key("global", "all", start)),
        ]);
        const clientCount = client?.data.count ?? 0;
        const globalCount = global?.data.count ?? 0;
        return {
          allowed: clientCount < maxPerClient && globalCount < maxGlobal,
          clientCount,
          globalCount,
          retryAfterMs: Math.max(0, start + windowMs - now()),
        };
      } catch (err) {
        if (err instanceof ConflictError) throw err;
        return { allowed: false, failedClosed: true, reason: err.message, retryAfterMs: windowMs };
      }
    },

    /** Drop windows that have already elapsed. */
    async sweep() {
      const keys = await store.listAll("rate-limits/");
      const cutoff = windowStart(now(), windowMs);
      let removed = 0;
      for (const { key: objectKey } of keys) {
        const start = Number(objectKey.split("/")[1]);
        if (Number.isFinite(start) && start < cutoff) {
          await store.delete(objectKey);
          removed++;
        }
      }
      return removed;
    },
  };
}
