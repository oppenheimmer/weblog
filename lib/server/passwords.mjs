// Owner password verification (CLAUDE.md Step 3).
//
// scrypt via node:crypto — no dependency, and the async form so a login never
// blocks the event loop of a function serving other requests.
//
// Parameters are stored *inside* the hash string rather than in code, so they
// can be raised later without invalidating an existing password: an old hash
// keeps verifying with the cost it was created at, and the next rotation picks
// up the new cost.
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

// N=2^17, r=8, p=1 — OWASP's current scrypt recommendation. Measured here at
// ~261 ms and ~128 MB, against ~63 ms at the 2^15 floor. Login happens about
// once per idle window, so a quarter-second is imperceptible to the owner and
// four times the work for anyone cracking a stolen hash offline. 128 MB sits
// comfortably inside a Vercel function's 1 GB. Re-benchmark on the deployment
// with scripts/set-password.mjs, which prints the measured time and says so if
// the value has drifted too high or too low.
export const DEFAULT_PARAMS = { N: 131072, r: 8, p: 1, keyLength: 32 };
const SALT_BYTES = 16;

// crypto.scrypt refuses to allocate 128*N*r bytes without headroom.
const maxmemFor = ({ N, r }) => 256 * N * r;

/** `scrypt$N$r$p$<salt-b64>$<hash-b64>` — self-describing and easy to eyeball. */
export async function hashPassword(password, params = DEFAULT_PARAMS) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Password must be a string of at least 12 characters.");
  }
  const { N, r, p, keyLength } = { ...DEFAULT_PARAMS, ...params };
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize("NFKC"), salt, keyLength, {
    N, r, p, maxmem: maxmemFor({ N, r }),
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export function parseHash(stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    throw new Error("Malformed password hash. Regenerate it with scripts/set-password.mjs.");
  }
  const [, N, r, p, salt, hash] = parts;
  return {
    N: Number(N), r: Number(r), p: Number(p),
    salt: Buffer.from(salt, "base64"),
    hash: Buffer.from(hash, "base64"),
  };
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing on a malformed stored hash, so a
 * misconfigured deployment fails closed instead of leaking the difference
 * between "wrong password" and "server is broken" to whoever is guessing.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || !stored) return false;
  let parsed;
  try {
    parsed = parseHash(stored);
  } catch {
    return false;
  }
  const { N, r, p, salt, hash } = parsed;
  try {
    const derived = await scrypt(password.normalize("NFKC"), salt, hash.length, {
      N, r, p, maxmem: maxmemFor({ N, r }),
    });
    // Lengths are equal by construction, but timingSafeEqual throws if they
    // ever are not, which would itself be an oracle.
    return derived.length === hash.length && crypto.timingSafeEqual(derived, hash);
  } catch {
    return false;
  }
}
