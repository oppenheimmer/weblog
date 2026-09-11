// Durable login rate limiting (CLAUDE.md Step 3; Appendix C, F-01 and F-02).
//
// In R2 rather than memory for the same reason sessions are: serverless
// instances share nothing, so an in-memory counter would let an attacker reset
// the limit simply by being routed to a cold instance.
//
// **An attempt is admitted before any password work, and admission is the
// count.** Counters rise by conditional write, so concurrent attempts each get
// a distinct count and only the first `limit` get through. The earlier design
// read the count first and recorded a failure only after scrypt had run: a
// synchronized burst all read the same count, all ran a 128 MiB scrypt, and the
// limit applied only to whatever came afterwards.
//
// **Two populations, because one shared budget was a lockout switch.** A global
// failure counter that refused everyone let any anonymous caller keep the owner
// from signing in. Now:
//
//   * A browser that has signed in before carries a signed device cookie. It
//     gets a budget of its own that nothing another client does can spend, so
//     failures elsewhere cannot lock the owner out of a browser they use.
//   * Every other attempt is limited per address and, together, by a shared
//     budget that bounds the password work anonymous traffic can cause in a
//     window. That budget can refuse a browser that has never signed in; it can
//     never refuse one that has.
//
// A device cookie is not a credential. It grants a separate counter and nothing
// else; the password is still required every time.
import crypto from "node:crypto";

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_PER_CLIENT = 5;
export const MAX_PER_DEVICE = 5;
export const MAX_GLOBAL = 50;
// Browsers cap cookie lifetimes at 400 days.
export const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
// What a caller is told to wait when its attempt could not be recorded.
const FAILED_CLOSED_RETRY_MS = 30 * 1000;

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

// ---------------------------------------------------------------- devices

const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;

function deviceMac(deviceId, secret) {
  if (!secret) throw new Error("RATE_LIMIT_HASH_SECRET is required");
  // Domain-separated from the address hashing that shares the secret.
  const key = crypto.createHmac("sha256", secret).update("weblog device cookie v1").digest();
  return crypto.createHmac("sha256", key).update(`v1.${deviceId}`).digest("base64url");
}

export const newDeviceId = () => crypto.randomBytes(16).toString("base64url");

/** A device cookie's value: its id and a MAC only this server can produce. */
export function signDevice(deviceId, secret) {
  if (!DEVICE_ID.test(String(deviceId))) throw new TypeError("not a device id");
  return `v1.${deviceId}.${deviceMac(deviceId, secret)}`;
}

/** The device id a cookie value names, or null for anything this server did not sign. */
export function verifyDevice(value, secret) {
  if (typeof value !== "string" || value.length > 200) return null;
  const [version, deviceId, mac, extra] = value.split(".");
  if (version !== "v1" || extra !== undefined || !DEVICE_ID.test(deviceId ?? "") || !mac) return null;
  const expected = Buffer.from(deviceMac(deviceId, secret));
  const presented = Buffer.from(mac);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected)
    ? deviceId
    : null;
}

// ---------------------------------------------------------------- limiter

export function createRateLimiter(store, {
  now = () => Date.now(),
  secret,
  windowMs = WINDOW_MS,
  maxPerClient = MAX_PER_CLIENT,
  maxPerDevice = MAX_PER_DEVICE,
  maxGlobal = MAX_GLOBAL,
} = {}) {
  const key = (scope, id, start) => `rate-limits/${start}/${scope}-${id}.json`;

  /** Add one to a counter in the current window, by conditional write. */
  async function charge(scope, id, limit) {
    const timestamp = now();
    const start = windowStart(timestamp, windowMs);
    const record = await store.mutateJson(key(scope, id, start), (current) => ({
      count: (current?.count ?? 0) + 1,
      windowStart: start,
      expiresAt: start + windowMs,
    }));
    return {
      scope, id, start, limit,
      count: record.count,
      allowed: record.count <= limit,
      retryAfterMs: Math.max(0, start + windowMs - timestamp),
    };
  }

  const decision = (charges) => {
    const refused = charges.filter((c) => !c.allowed);
    return {
      allowed: refused.length === 0,
      charges,
      retryAfterMs: refused.length ? Math.max(...refused.map((c) => c.retryAfterMs)) : 0,
    };
  };

  return {
    /**
     * Claim one login attempt, before any password work.
     *
     * `device` is an id from identifyDevice, or null. Fails **closed**: an
     * attempt that cannot be counted is refused, because letting it through
     * uncounted would be silently switching the limit off.
     */
    async admit({ client, device = null } = {}) {
      try {
        if (device) {
          return decision([await charge("device", hashClient(device, secret), maxPerDevice)]);
        }
        const perClient = await charge("client", hashClient(client, secret), maxPerClient);
        // An address already over its limit spends nothing from the shared budget.
        if (!perClient.allowed) return decision([perClient]);
        return decision([perClient, await charge("global", "untrusted", maxGlobal)]);
      } catch (err) {
        return {
          allowed: false, failedClosed: true, reason: err.message,
          charges: [], retryAfterMs: FAILED_CLOSED_RETRY_MS,
        };
      }
    },

    /**
     * Give back an admitted attempt whose password was correct, so signing in
     * costs the owner nothing. Only a correct password reaches this, so it can
     * never reopen admission for anyone guessing.
     */
    async release(admission) {
      for (const c of admission?.charges ?? []) {
        try {
          await store.mutateJson(key(c.scope, c.id, c.start), (current) =>
            (current ? { ...current, count: Math.max(0, current.count - 1) } : undefined));
        } catch {
          // A refund that fails leaves one attempt counted. Never fail a
          // correct sign-in over bookkeeping.
        }
      }
    },

    /** The device a cookie names, or null for anything this server did not sign. */
    identifyDevice(value) {
      try {
        return verifyDevice(value, secret);
      } catch {
        return null;
      }
    },

    /** A signed cookie value for a device, minting an id if it has none yet. */
    deviceCookie(deviceId = null) {
      const id = deviceId ?? newDeviceId();
      return { id, value: signDevice(id, secret) };
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
