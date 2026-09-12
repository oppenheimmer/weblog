// Proves, in a real browser, what seals a sealed lab (CLAUDE.md §3.6, Slice 6A).
//
//   node scripts/verify-demo-sandbox.mjs
//   CHROMIUM=/path/to/chrome node scripts/verify-demo-sandbox.mjs
//
// §3.6 makes two claims that the rest of the interactive design is built on,
// and neither is safe to take on faith:
//
//   1. **A response header, not an iframe attribute, is what closes the hole.**
//      A lab payload has a URL of its own. Opened directly rather than framed it
//      would be an ordinary same-origin document on the editor's hostname, with
//      full rights over the session — so the sandbox has to arrive with the
//      response, and keep arriving when nobody remembered to frame it.
//   2. **An opaque origin still lets a bundle read itself.** Module scripts are
//      always fetched in CORS mode, so from the sandbox the lab's own
//      `./demo.mjs` and `./data.json` are cross-origin reads that need an
//      explicit read header. If that were wrong, §3.6's whole bundle shape —
//      relative filenames, modules importing modules — would be wrong with it.
//
// The site is served locally with the header rules read from `vercel.json`
// itself (`lib/routing.mjs`), so this measures the configuration that ships
// rather than a copy of it. Requests are the oracle: an image beacon reaches
// the server whether or not CORS lets the page read a reply, which keeps
// "never happened" distinguishable from "happened and was refused".
//
// Two controls, because one would not be enough. Dropping the header must break
// the seal, and dropping the read header must break the bundle — otherwise a
// passing run would prove only that something somewhere is allowed.
//
// What this cannot settle: whether Vercel applies these rules to static output
// at all. That is a platform claim, confirmed on a real deployment when the
// first bundle ships (Slice 6C).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startPageReader, browserVersion, cannotRun } from "./chromium.mjs";
import { readRouting, headersFor, fileFor } from "../lib/routing.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE = path.join(ROOT, "test", "fixtures", "interactives", "probe-lab");

// The public shape §3.6 specifies: /demos/<post-slug>/<name>/<revision>/.
const DEMO_BASE = "/demos/a-post/probe-lab/rev1/";

const routing = readRouting(JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")));

// Modelled on the real session cookie, which is HttpOnly — so what the lab can
// read with script and what the browser is willing to *send* are two different
// questions, and both are asked below.
const SESSION_COOKIE = "weblog_session_probe=s3cret; HttpOnly; SameSite=Strict; Path=/";
const VISIBLE_COOKIE = "weblog_visible_probe=visible; SameSite=Strict; Path=/";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// ---- the site ----------------------------------------------------------------

const hits = [];
let mode = { csp: true, acao: true, framed: false, frameSandbox: true };
let appliedToEntry = new Map();

/** The headers vercel.json gives this path, minus whatever the current run withholds. */
function configured(pathname) {
  const headers = headersFor(routing, pathname);
  if (!mode.csp) headers.delete("content-security-policy");
  if (!mode.acao) headers.delete("access-control-allow-origin");
  return headers;
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  const send = (status, extra, body) => {
    res.writeHead(status, { ...Object.fromEntries(configured(pathname)), ...extra });
    res.end(body);
  };

  // The site's own entry: hands out the cookies a lab must not be able to use,
  // then either frames the lab or sends the browser straight at it.
  if (pathname === "/") {
    const cookies = { "set-cookie": [SESSION_COOKIE, VISIBLE_COOKIE] };
    if (!mode.framed) return send(302, { ...cookies, location: DEMO_BASE });
    const sandbox = mode.frameSandbox ? ' sandbox="allow-scripts"' : "";
    return send(200, { ...cookies, "content-type": "text/html; charset=utf-8" },
      `<!doctype html><title>clean</title>
<iframe src="${DEMO_BASE}"${sandbox} referrerpolicy="no-referrer"></iframe>`);
  }

  // An API route, present so the run can show that a bundle's read header stops
  // at the bundle. Its reply is beside the point; the cookies it was sent are not.
  if (pathname === "/api/session-probe/") {
    const cookie = req.headers.cookie ?? "";
    const names = cookie ? cookie.split(";").map((c) => c.split("=")[0].trim()).sort().join("+") : "none";
    hits.push(`api cookies=${names}`);
    hits.push(`api read-header=${configured(pathname).has("access-control-allow-origin") ? "yes" : "no"}`);
    return send(200, { "content-type": "application/json" }, "{}");
  }

  if (pathname.startsWith("/hit/")) {
    hits.push(`hit ${pathname.slice("/hit/".length)}`);
    return send(204, {});
  }

  // The bundle, served at the public path shape, from the fixture folder. The
  // request is logged before the reply, so a module that was fetched and then
  // rejected by CORS is distinguishable from one never asked for.
  if (pathname.startsWith(DEMO_BASE)) {
    hits.push(`bundle ${pathname.slice(DEMO_BASE.length) || "(index)"}`);
    const served = fileFor(routing, pathname);
    if (!served) return send(404, {});
    const file = path.join(BUNDLE, served.slice(DEMO_BASE.length - 1));
    if (!fs.existsSync(file)) return send(404, {});
    if (pathname === DEMO_BASE) appliedToEntry = configured(pathname);
    return send(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" },
      fs.readFileSync(file));
  }

  send(404, {});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const SITE = `http://127.0.0.1:${server.address().port}`;

// ---- the browser -------------------------------------------------------------

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-chrome-"));
const reader = await startPageReader(profile);

/** A load is finished when requests stop arriving, not after a fixed wait. */
async function quiet(ms = 750, cap = 8000) {
  const deadline = Date.now() + cap;
  let seen = -1;
  while (hits.length !== seen && Date.now() < deadline) {
    seen = hits.length;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function run(label, next) {
  mode = { csp: true, acao: true, framed: false, frameSandbox: true, ...next };
  hits.length = 0;
  appliedToEntry = new Map();
  let result;
  try {
    result = await reader.read(`${SITE}/`, { settle: quiet });
  } catch (err) {
    cannotRun(`the ${label} run could not be loaded over the DevTools protocol`, err.message);
  }
  // The lab has to have run at all. Without this, every "it could not reach the
  // session" check below would pass just as well on a page that never loaded —
  // the failure mode this project has already been bitten by once.
  if (!hits.includes("hit inline-ran")) {
    cannotRun(`the ${label} run never executed the lab, so nothing it claims was measured`,
      hits.join("\n"));
  }
  return { ...result, hits: [...hits] };
}

const results = [];
const check = (name, ok, saw) => {
  results.push(ok);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
  // A failure has to say what it saw. A browser boundary moving is exactly the
  // news this check exists to deliver, and "FAIL" alone does not deliver it.
  if (!ok && saw !== undefined) console.log(`          saw: ${saw}`);
};
const has = (run, entry) => run.hits.includes(entry);
const hasPrefix = (run, prefix) => run.hits.some((h) => h.startsWith(prefix));
const value = (run, prefix) => {
  const found = run.hits.find((h) => h.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : "(not reported)";
};

console.log(`${browserVersion()}`);
console.log(`Lab served at ${DEMO_BASE} with the rules in vercel.json\n`);

// ---- 1. as configured, opened directly ---------------------------------------

const direct = await run("direct", { framed: false });
console.log("Opened directly, headers as vercel.json sets them:");
console.log(`  (${[...appliedToEntry].map(([k, v]) => `${k}: ${v}`).join("; ") || "no headers"})`);
check("the lab's own origin is opaque, so it is nobody's same-origin document",
  value(direct, "hit origin/") === "null");
// Measured in Chromium 152: reading `document.cookie` from an opaque origin
// *throws* a SecurityError rather than returning empty — stronger than the
// claim needs. Both answers satisfy it, and pinning which one would make this
// brittle against a browser that is no less strict, only differently so.
check("script-readable cookies are unreachable",
  ["(none)", "threw"].includes(value(direct, "hit cookie/")), value(direct, "hit cookie/"));
check("its request to the API carries no session cookie",
  has(direct, "api cookies=none"));
check("localStorage is denied",
  has(direct, "hit storage/denied"));
check("the API response carries no bundle read header",
  has(direct, "api read-header=no"));
check("its entry module loads over a relative path",
  hasPrefix(direct, "hit module-ran/"));
check("…and that module's own relative import resolves",
  value(direct, "hit module-ran/") === "nested");
check("it reads its own JSON beside the entry",
  has(direct, "hit data/read"));
check("a classic script loads too",
  has(direct, "hit classic-ran"));

// ---- 2. as configured, framed the way the engine will frame it ---------------

const framed = await run("framed", { framed: true, frameSandbox: true });
console.log("\nFramed with sandbox=\"allow-scripts\", headers as configured:");
check("the page around it is untouched", framed.title === "clean");
check("the lab is told it cannot reach that page", has(framed, "hit parent/denied"));
check("it is no less capable for being framed", hasPrefix(framed, "hit module-ran/"));
check("it still cannot see the session", has(framed, "api cookies=none"));

// ---- 3. the header alone, with the attribute forgotten ----------------------

const headerOnly = await run("header-only", { framed: true, frameSandbox: false });
console.log("\nFramed with no sandbox attribute — the response header alone:");
check("the page around it is still untouched", headerOnly.title === "clean");
check("the lab is still denied that page", has(headerOnly, "hit parent/denied"));

// ---- 4. control: the same bundle without the sandbox header ------------------

const noCsp = await run("no-header control", { csp: false, framed: false });
console.log("\nControl, the same bundle served without the sandbox header:");
check("it becomes an ordinary document on the site's own origin",
  value(noCsp, "hit origin/") === SITE);
check("…and reads the site's script-visible cookies — which the header prevents",
  value(noCsp, "hit cookie/").includes("weblog_visible_probe"));
check("…and its requests carry the session cookie — which the header prevents",
  hasPrefix(noCsp, "api cookies=weblog_session_probe"));

const noCspFramed = await run("no-header framed control", { csp: false, framed: true, frameSandbox: false });
console.log("\nControl, framed with neither the header nor the attribute:");
check("the lab reaches the page around it — so the two checks above can see it",
  noCspFramed.title === "pwned" && has(noCspFramed, "hit parent/reached"));

// ---- 5. control: the sandbox header, but no read header on the bundle --------

const noAcao = await run("no-read-header control", { acao: false, framed: false });
console.log("\nControl, sandboxed as configured but with no read header on the bundle:");
check("the entry module is fetched and then refused, so the lab never starts",
  has(noAcao, "bundle demo.mjs") && !hasPrefix(noAcao, "hit module-ran/"));
check("reading its own JSON is refused too", has(noAcao, "hit data/blocked"));
check("a classic script still runs — why 'it loads' is not evidence the bundle works",
  has(noAcao, "hit classic-ran"));

await reader.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
