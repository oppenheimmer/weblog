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
import { mdBrowser } from "../lib/markdown.mjs";
import { INTERACTIVE_FENCE } from "../lib/interactives.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, "test", "fixtures", "interactives");

// The public shapes §3.6 specifies. A lab and a figure differ by prefix, which
// is what lets response headers treat them differently.
const DEMO_BASE = "/demos/a-post/probe-lab/iv_00000000000000c1/";
const FIGURE_BASE = "/assets/figures/a-post/probe-figure/iv_00000000000000d1/";
const MOUNTS = [
  { base: DEMO_BASE, dir: path.join(FIXTURES, "probe-lab") },
  { base: FIGURE_BASE, dir: path.join(FIXTURES, "probe-figure") },
];

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
let mode = { csp: true, acao: true, framed: false, frameSandbox: true, target: "lab" };
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
    const html = (body) => send(200, { ...cookies, "content-type": "text/html; charset=utf-8" }, body);

    // A post page importing its figure: an ordinary same-origin document, with
    // no sandbox of its own. §3.6 grants the module this page deliberately.
    if (mode.target === "figure-host") {
      return html(`<!doctype html><title>clean</title>
<div id="figure-root"></div>
<script type="module" src="/probe/figure-host.mjs"></script>`);
    }
    // A real page: the renderer's own output for a resolved ::demo, driven by
    // the site's own script. Nothing here is a stand-in except the surrounding
    // chrome — the figure markup and the upgrade to an iframe are the shipping
    // code, which is the only way to measure that a listing runs nothing.
    if (mode.target === "post-page" || mode.target === "listing-page") {
      const fence = (payload) =>
        `\`\`\`${INTERACTIVE_FENCE}\n${JSON.stringify(payload)}\n\`\`\``;
      const blocks = [
        fence({
          kind: "demo", name: "probe-lab",
          src: `${DEMO_BASE}index.html`,
          fallback: "<p>A still picture of the lab.</p>",
        }),
      ];
      if (mode.withFigure) {
        blocks.push(fence({
          kind: "figure", name: "probe-figure",
          src: `${FIGURE_BASE}main.mjs`,
          // Declared by name; the engine loads it from assets/vendor/.
          dependencies: ["d3"],
          fallback: "<p>A still chart.</p>",
        }));
      }
      const article = mdBrowser.render(`Before.\n\n${blocks.join("\n\n")}\n\nAfter.\n`);
      const bodyClass = mode.target === "post-page" ? "blog-page post-page" : "blog-page list-page";
      return html(`<!doctype html><title>clean</title>
<body class="${bodyClass}">
${article}
<script src="/assets/blog.js"></script>
<script src="/probe/page-ready.js"></script>`);
    }

    // The one document a figure bundle may contain, opened directly.
    if (mode.target === "figure-doc") {
      return send(302, { ...cookies, location: `${FIGURE_BASE}fallback.html` });
    }
    if (!mode.framed) return send(302, { ...cookies, location: DEMO_BASE });
    const sandbox = mode.frameSandbox ? ' sandbox="allow-scripts"' : "";
    return html(`<!doctype html><title>clean</title>
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

  // The engine's vendored libraries, from the repository, as the build copies
  // them. Logged, so "the page asked for it" is measured, not assumed.
  if (pathname.startsWith("/assets/vendor/")) {
    const file = path.join(ROOT, "assets", "vendor", path.basename(pathname));
    hits.push(`vendor ${path.basename(pathname)}`);
    if (!fs.existsSync(file)) return send(404, {});
    return send(200, { "content-type": "text/javascript; charset=utf-8" }, fs.readFileSync(file));
  }

  if (pathname === "/assets/blog.js") {
    hits.push("asset blog.js");
    return send(200, { "content-type": "text/javascript; charset=utf-8" },
      fs.readFileSync(path.join(ROOT, "assets", "blog.js")));
  }

  // Probe instrumentation is external because public pages now admit only
  // exact shipping inline hashes. Keeping the harness's changing code inline
  // would test that CSP blocks it, not the interactive boundary below.
  if (pathname === "/probe/figure-host.mjs") {
    return send(200, { "content-type": "text/javascript; charset=utf-8" }, `
      new Image().src = "/hit/figure-host-loaded";
      import * as figure from "${FIGURE_BASE}main.mjs";
      figure.mount(document.getElementById("figure-root"), { theme: "light" });
    `);
  }
  if (pathname === "/probe/page-ready.js") {
    return send(200, { "content-type": "text/javascript; charset=utf-8" }, `
      // Fired whatever the engine did, so "the page ran" stays separable from
      // "the engine built a frame".
      new Image().src = "/hit/page-ready";
      setTimeout(function () {
        var frame = document.querySelector('figure[data-interactive="demo"] iframe');
        new Image().src = "/hit/page-frame/" + (frame
          ? encodeURIComponent(frame.getAttribute("sandbox") + "|" + frame.getAttribute("referrerpolicy"))
          : "none");
        if (frame) {
          setTimeout(function () {
            new Image().src = "/hit/page-height/" + encodeURIComponent(frame.style.height || "unset");
          }, 900);
        }
        setTimeout(function () {
          var fig = document.querySelector('figure[data-interactive="figure"]');
          new Image().src = "/hit/page-figure/" + encodeURIComponent(fig
            ? [fig.className, (fig.querySelector(".interactive-root") || {}).textContent || ""].join("|")
            : "absent");
        }, 900);
      }, 600);
    `);
  }

  if (pathname.startsWith("/hit/")) {
    hits.push(`hit ${pathname.slice("/hit/".length)}`);
    return send(204, {});
  }

  // The bundle, served at the public path shape, from the fixture folder. The
  // request is logged before the reply, so a module that was fetched and then
  // rejected by CORS is distinguishable from one never asked for.
  const mount = MOUNTS.find((m) => pathname.startsWith(m.base));
  if (mount) {
    hits.push(`bundle ${pathname.slice(mount.base.length) || "(index)"}`);
    const served = fileFor(routing, pathname);
    if (!served) return send(404, {});
    const file = path.join(mount.dir, served.slice(mount.base.length - 1));
    if (!fs.existsSync(file)) return send(404, {});
    if (pathname === mount.base) appliedToEntry = configured(pathname);
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

async function run(label, next, { alive = "hit inline-ran" } = {}) {
  mode = { csp: true, acao: true, framed: false, frameSandbox: true, target: "lab", ...next };
  hits.length = 0;
  appliedToEntry = new Map();
  let result;
  try {
    result = await reader.read(`${SITE}/`, { settle: quiet });
  } catch (err) {
    cannotRun(`the ${label} run could not be loaded over the DevTools protocol`, err.message);
  }
  // The page has to have run at all. Without this, every "it could not reach
  // the session" check below would pass just as well on a page that never
  // loaded — the failure mode this project has already been bitten by once.
  //
  // The sentinel must be something true whether or not the boundary holds.
  // A sentinel that is itself a boundary claim turns a *measured failure* into
  // "this environment cannot run the check", which is exit 2 instead of exit 1
  // and reads as the opposite of the truth. Mutation testing caught exactly
  // that here: dropping the figure path's sandbox header made the run abort
  // as un-runnable while its own log showed the fallback reading cookies.
  if (!hits.includes(alive)) {
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

// ---- 6. the other pathway: a figure, which is page code on purpose ---------

const figureHost = await run("figure host", { target: "figure-host" },
  { alive: "hit figure-host-loaded" });
console.log("\nA figure imported by an ordinary post page:");
check("its entry module runs, over a relative path",
  has(figureHost, "hit figure-module-ran/figure"));
check("…and reaches the page that imported it, which is the grant §3.6 makes",
  figureHost.title === "mounted", `page title was "${figureHost.title}"`);
check("no read header is needed, because the page and the bundle share an origin",
  !headersFor(routing, `${FIGURE_BASE}main.mjs`).has("access-control-allow-origin"));

// A figure bundle may still contain one document — its required fallback — and
// that document is served from the post's own hostname. The contract refuses
// every *other* HTML file (lib/interactives.mjs), so this is the only one, and
// the header is what stops it being an ordinary same-origin page.
const figureDoc = await run("figure document", { target: "figure-doc" },
  { alive: "hit figure-fallback-ran" });
console.log("\nA figure's fallback, opened directly:");
check("it is sandboxed too, despite being page-code's neighbour",
  has(figureDoc, "hit figure-fallback/null"));
check("and it cannot read the site's cookies",
  has(figureDoc, "hit figure-cookie/threw") || has(figureDoc, "hit figure-cookie/(none)"));

const figureDocControl = await run("figure document control", { target: "figure-doc", csp: false },
  { alive: "hit figure-fallback-ran" });
console.log("\nControl, the same fallback without the sandbox header:");
check("it is an ordinary document on the site's origin — so the check above can see it",
  value(figureDocControl, "hit figure-fallback/") === SITE,
  value(figureDocControl, "hit figure-fallback/"));

// ---- 7. the real page, and the listing that must not run it ---------------

const postPage = await run("post page", { target: "post-page" }, { alive: "hit page-ready" });
console.log("\nA published post page, rendered and upgraded by the site's own script:");
check("the engine builds the frame, sandboxed and without a referrer",
  value(postPage, "hit page-frame/") === "allow-scripts|no-referrer",
  value(postPage, "hit page-frame/"));
check("the lab loads and runs inside it", has(postPage, "hit inline-ran"));
check("it still cannot reach the page around it", has(postPage, "hit parent/denied"));
check("the page is untouched", postPage.title === "clean", postPage.title);
check("the bridge tells the lab the reader's preferences",
  hasPrefix(postPage, "hit bridge-context/"), value(postPage, "hit bridge-context/"));
check("…and accepts a height it asks for",
  value(postPage, "hit page-height/") === "321px", value(postPage, "hit page-height/"));
// The lab sends 321, then an unknown type, then a height far outside what a
// page may be — in that order, so the last message wins if anything is
// accepted blindly. The height staying at 321 is the measurement.
check("…while ignoring a height outside what a page may be",
  value(postPage, "hit page-height/") !== "99999px",
  value(postPage, "hit page-height/"));
check("…and a message type the bridge does not define",
  postPage.title === "clean", postPage.title);

// ---- 8. the other pathway again, on a real page --------------------------

const figurePage = await run("figure page", { target: "post-page", withFigure: true },
  { alive: "hit page-ready" });
console.log("\nAn article figure on a post page, mounted by the engine:");
check("the engine calls mount(root, context) with what only it knows",
  value(figurePage, "hit figure-mount/") === "figure,light,false,number",
  value(figurePage, "hit figure-mount/"));
check("the figure draws into the root it was given, and the fallback steps aside",
  value(figurePage, "hit page-figure/").includes("interactive--live") &&
  value(figurePage, "hit page-figure/").includes("mounted"),
  value(figurePage, "hit page-figure/"));
check("a lab on the same page is unaffected",
  has(figurePage, "hit inline-ran") && postPage.title === "clean");
check("the d3 it declared is loaded from this site first, and the module sees 7.9.0",
  has(figurePage, "vendor d3.v7.9.0.min.js") && value(figurePage, "hit figure-d3/") === "7.9.0",
  value(figurePage, "hit figure-d3/"));

const figureListing = await run("figure in a listing", { target: "listing-page", withFigure: true },
  { alive: "hit page-ready" });
console.log("\nThe same figure in a listing, where §3.6 says nothing may run:");
check("its module is never imported", !hasPrefix(figureListing, "hit figure-mount/"));
check("and the library it declared is never fetched", !has(figureListing, "vendor d3.v7.9.0.min.js"));
check("the fallback is what remains",
  value(figureListing, "hit page-figure/").includes("interactive--figure") &&
  !value(figureListing, "hit page-figure/").includes("interactive--live"),
  value(figureListing, "hit page-figure/"));

const listingPage = await run("listing page", { target: "listing-page" }, { alive: "hit page-ready" });
console.log("\nThe same article in a listing, where §3.6 says nothing may run:");
check("no frame is built", has(listingPage, "hit page-frame/none"));
check("nothing of the lab is even requested",
  !listingPage.hits.some((hit) => hit.startsWith("bundle")),
  listingPage.hits.filter((hit) => hit.startsWith("bundle")).join(", "));

await reader.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
