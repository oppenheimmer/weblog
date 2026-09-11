// Counts crypto.scrypt calls, for tests that must prove how often a password
// was actually verified rather than what the responses said.
//
// Import this before anything that imports lib/server/passwords.mjs: that
// module captures scrypt when it loads, so a wrapper installed later is never
// called.
import crypto from "node:crypto";

export const scryptCalls = { count: 0 };

const original = crypto.scrypt;
crypto.scrypt = function countedScrypt(...args) {
  scryptCalls.count++;
  return original.apply(this, args);
};
