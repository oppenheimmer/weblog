// Owner sessions, stored in R2 (CLAUDE.md Step 3).
//
// Durable by necessity, not preference: serverless instances share no memory,
// so an in-memory session table would log the owner out at random whenever a
// request landed on a cold instance.
//
// Only a *hash* of the token is stored. Read access to the bucket therefore
// does not hand anyone a usable session.
import crypto from "node:crypto";

// Owner decision: idle timeout rather than an absolute cap, so a long writing
// session is never interrupted, with a hard ceiling so an abandoned session
// still dies.
export const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;      // 8 hours since last use
export const ABSOLUTE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days since login

// Refreshing on every request would mean a write per request. Only extend when
// the session is meaningfully older than its last touch.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const TOKEN_BYTES = 32;
const CSRF_BYTES = 32;

export const sessionKey = (tokenHash) => `sessions/${tokenHash}.json`;

/** Tokens are looked up by hash, so the plaintext never reaches storage. */
export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function createSessionStore(store, {
  now = () => Date.now(),
  authVersion = 1,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  absoluteLifetimeMs = ABSOLUTE_LIFETIME_MS,
} = {}) {
  const api = {
    /** Mint a session. The plaintext token is returned once and never stored. */
    async create({ userAgentHash } = {}) {
      const token = newToken();
      const timestamp = now();
      const record = {
        tokenHash: hashToken(token),
        csrfSecret: crypto.randomBytes(CSRF_BYTES).toString("base64url"),
        authVersion,
        createdAt: timestamp,
        lastSeenAt: timestamp,
        expiresAt: timestamp + absoluteLifetimeMs,
        userAgentHash: userAgentHash ?? null,
      };
      await store.createJson(sessionKey(record.tokenHash), record);
      return { token, session: record };
    },

    /**
     * Resolve a token to a live session, or null.
     *
     * Expiry is enforced here on every read, independently of any later
     * cleanup: a record that outlives its own deadline must never authenticate,
     * even if a sweep has not yet deleted it.
     */
    async verify(token) {
      if (!token || typeof token !== "string") return null;
      const tokenHash = hashToken(token);
      const record = await store.getJson(sessionKey(tokenHash));
      if (!record) return null;

      const session = record.data;
      const timestamp = now();

      // Rotating AUTH_VERSION revokes every session at once — the recovery path
      // for a suspected compromise.
      if (session.authVersion !== authVersion) return null;
      if (timestamp >= session.expiresAt) return null;
      if (timestamp - session.lastSeenAt >= idleTimeoutMs) return null;

      // Idle window slides forward, but the absolute ceiling never moves.
      if (timestamp - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
        try {
          await store.updateJson(
            sessionKey(tokenHash),
            { ...session, lastSeenAt: timestamp },
            record.etag
          );
        } catch {
          // A concurrent request already refreshed it. Harmless: the session is
          // valid either way, and failing the request over a bookkeeping write
          // would be worse than skipping it.
        }
      }

      return { ...session, lastSeenAt: timestamp };
    },

    async revoke(token) {
      if (!token) return false;
      await store.delete(sessionKey(hashToken(token)));
      return true;
    },

    /** Delete expired records. Correctness never depends on this running. */
    async sweep() {
      const keys = await store.listAll("sessions/");
      const timestamp = now();
      let removed = 0;
      for (const { key } of keys) {
        const record = await store.getJson(key);
        if (!record) continue;
        const session = record.data;
        const dead =
          session.authVersion !== authVersion ||
          timestamp >= session.expiresAt ||
          timestamp - session.lastSeenAt >= idleTimeoutMs;
        if (dead) {
          await store.delete(key);
          removed++;
        }
      }
      return removed;
    },
  };

  return api;
}

// ---------------------------------------------------------------- CSRF

/**
 * Per-session CSRF token, derived from the session's secret rather than stored.
 *
 * Derivation means there is no second record to keep in sync, and a token is
 * only valid for the session it was issued to — a token lifted from one session
 * cannot be replayed against another.
 */
export function csrfToken(session) {
  if (!session?.csrfSecret) throw new Error("session has no csrfSecret");
  return crypto.createHmac("sha256", session.csrfSecret).update("csrf").digest("base64url");
}

export function verifyCsrf(session, presented) {
  if (!session?.csrfSecret || typeof presented !== "string") return false;
  const expected = Buffer.from(csrfToken(session));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
