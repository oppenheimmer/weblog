// Finding and starting Chromium for the browser checks.
//
// A browser that fails to start must say so. The DevTools-protocol scripts
// used to spawn Chrome with its output discarded, wait for a port file it
// never wrote, and fail with ENOENT twenty seconds later — which named the
// file, not the reason. On a CI runner whose sandbox Chrome cannot use, that
// is the entire diagnosis missing.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const CHROMIUM = process.env.CHROMIUM || "chromium-browser";

// Extra flags for environments the checks do not control. A CI container
// usually needs --no-sandbox, because Chrome's own sandbox wants user
// namespaces the runner restricts, and --disable-dev-shm-usage where /dev/shm
// is small.
//
// Worth being exact about what that costs, since two of these checks are
// security checks: --no-sandbox drops Chrome's OS-level process isolation. It
// does not touch the boundaries being measured — the iframe sandbox attribute,
// the same-origin policy and CSP are enforced by the renderer itself, and a
// control run still proves each check can fail. Locally it stays unset.
export const EXTRA_FLAGS = (process.env.CHROMIUM_FLAGS || "").split(/\s+/).filter(Boolean);

export const BASE_FLAGS = [
  "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  // Nothing leaves the machine: Google Fonts and the like resolve to nowhere.
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start Chrome with remote debugging and return its address.
 *
 * Exits 2 — never 1, and never a pass — when the browser cannot start, so a
 * check that did not run is distinguishable from one that failed.
 */
export async function startDevTools(profile, { waitMs = 20_000 } = {}) {
  const args = [
    ...BASE_FLAGS,
    `--user-data-dir=${profile}`, "--remote-debugging-port=0",
    ...EXTRA_FLAGS,
    "about:blank",
  ];
  const chrome = spawn(CHROMIUM, args, { stdio: ["ignore", "ignore", "pipe"] });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => { stderr += chunk; });

  let exited = null;
  chrome.on("exit", (code, signal) => { exited = signal ? `signal ${signal}` : `exit code ${code}`; });

  const give_up = (why) => {
    const detail = stderr.trim().split("\n").slice(-6).join("\n");
    console.log(`Could not run ${CHROMIUM}: ${why}`);
    if (EXTRA_FLAGS.length) console.log(`  extra flags: ${EXTRA_FLAGS.join(" ")}`);
    if (detail) console.log(`  browser said:\n${detail.replace(/^/gm, "    ")}`);
    else console.log("  the browser said nothing at all.");
    console.log("  If this is a container, try CHROMIUM_FLAGS='--no-sandbox --disable-dev-shm-usage'.");
    process.exit(2);
  };

  chrome.on("error", (err) => give_up(err.message));

  const portFile = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + waitMs;
  while (!fs.existsSync(portFile)) {
    if (exited) give_up(`the browser stopped before it was ready (${exited})`);
    if (Date.now() > deadline) give_up(`it did not open a debugging port within ${waitMs / 1000}s`);
    await sleep(50);
  }

  const [port, browserPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
  return { chrome, port, browserPath, url: `ws://127.0.0.1:${port}${browserPath}` };
}
