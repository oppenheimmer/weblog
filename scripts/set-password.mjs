// Generate the editor password hash.
//
//   node scripts/set-password.mjs
//
// Prompts twice with echo off and prints a hash to paste into Vercel's project
// settings as ADMIN_PASSWORD_HASH. The password is never taken as an argument:
// that would put it in shell history, the process list, and any log that
// captures either.
import readline from "node:readline";
import { hashPassword, verifyPassword, DEFAULT_PARAMS } from "../lib/server/passwords.mjs";

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY) {
      reject(new Error("Refusing to read a password from a pipe; run this in a terminal."));
      return;
    }

    const rl = readline.createInterface({ input, output, terminal: true });
    // Swallow the echo of every keystroke, but keep the prompt itself visible.
    let prompted = false;
    const onWrite = (chunk, encoding, callback) => {
      if (!prompted) {
        prompted = true;
        return readline.Interface.prototype._writeToOutput.call(rl, chunk, encoding, callback);
      }
    };
    rl._writeToOutput = onWrite;

    rl.question(question, (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer);
    });
    rl.on("SIGINT", () => {
      rl.close();
      output.write("\n");
      reject(new Error("cancelled"));
    });
  });
}

try {
  console.log("Set the editor password. Minimum 12 characters; a passphrase is easier to");
  console.log("remember and stronger than a short complex string.\n");

  const password = await promptHidden("Password: ");
  const again = await promptHidden("Confirm:  ");

  if (password !== again) {
    console.error("\nThe two entries did not match. Nothing was written.");
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("\nToo short: at least 12 characters. Nothing was written.");
    process.exit(1);
  }

  const started = Date.now();
  const hash = await hashPassword(password, DEFAULT_PARAMS);
  const elapsed = Date.now() - started;

  // Prove the hash actually verifies before it is trusted anywhere.
  if (!(await verifyPassword(password, hash))) {
    console.error("\nThe generated hash failed to verify. Do not use it; this is a bug.");
    process.exit(1);
  }

  console.log(`\nHashed in ${elapsed} ms (scrypt N=${DEFAULT_PARAMS.N}, r=${DEFAULT_PARAMS.r}, p=${DEFAULT_PARAMS.p}).`);
  if (elapsed > 1500) {
    console.log("That is slow enough to hurt login latency — consider lowering N in lib/server/passwords.mjs.");
  } else if (elapsed < 50) {
    console.log("That is fast enough to be worth raising — consider increasing N in lib/server/passwords.mjs.");
  }

  console.log("\nSet this as ADMIN_PASSWORD_HASH in Vercel project settings:\n");
  console.log(hash);
  console.log("\nChanging it later both sets a new password and invalidates every existing");
  console.log("session, which is the recovery path if you are ever locked out.");
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
