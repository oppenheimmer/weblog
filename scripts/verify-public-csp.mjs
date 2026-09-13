// Measures the CSP carried by every generated public page (CLAUDE.md §3.6).
//
//   node scripts/verify-public-csp.mjs
//   CHROMIUM=/path/to/chrome node scripts/verify-public-csp.mjs
//
// The real templates are served from one loopback origin and an attempted
// third-party module and fetch from another. Requests, not console messages,
// are the oracle. A control strips the policy and must make both outside
// requests arrive, so a passing configured run cannot mean the probes failed
// to execute.
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { browserVersion, cannotRun, startPageReader } from "./chromium.mjs";
import { listPage, postPage } from "../lib/templates.mjs";
import { headersFor, readRouting } from "../lib/routing.mjs";
import { DISTILL_STYLE_HASHES } from "../lib/distill.mjs";

const ENGINE = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const KATEX = path.join(ENGINE, "node_modules", "katex", "dist");

const outsideHits = [];
const siteHits = [];

const outside = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  outsideHits.push(pathname);
  if (pathname === "/outside.mjs") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(`new Image().src = ${JSON.stringify(`${siteOrigin}/hit/outside-script`)};`);
  }
  if (pathname === "/data") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("{}");
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => outside.listen(0, "127.0.0.1", resolve));
const OUTSIDE = `http://127.0.0.1:${outside.address().port}`;

let control = false;
let distillControl = false;

// A public page using every Distill component, as the engine's own Distill
// hook renders one. The probe hashes every style element on the page and in
// every shadow root; a block the browser refused has no stylesheet.
const DISTILL_HTML = `
<d-title><h1>Distill probe</h1><p>A lede.</p></d-title>
<d-byline></d-byline>
<d-article>
  <p>Inline <d-math>x^2 + y^2</d-math>, a footnote<d-footnote>A footnote.</d-footnote>, a citation<d-cite key="goh2017"></d-cite>.</p>
  <d-math block="">\\int_0^1 x\\,dx = \\tfrac12</d-math>
  <d-figure><figcaption>A caption.</figcaption></d-figure>
  <d-slider min="0" max="1" step="0.01" value="0.5"></d-slider>
  <d-code block="" language="javascript">const answer = 42;</d-code>
  <d-abstract><p>Abstract.</p></d-abstract>
</d-article>
<d-appendix><d-footnote-list></d-footnote-list><d-citation-list></d-citation-list></d-appendix>
<d-bibliography><script type="text/bibtex">@article{goh2017, title={Why Momentum Really Works}, author={Goh, Gabriel}, journal={Distill}, year={2017}}</script></d-bibliography>`;
const DISTILL_PROBE = `
import { DISTILL_STYLE_HASHES } from "/lib/distill.mjs";
const hit = (p) => { new Image().src = "/hit/" + p; };
await new Promise((resolve) => setTimeout(resolve, 3500));
const roots = [];
(function walk(node) {
  roots.push(node);
  for (const el of node.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
})(document);
const blocks = [];
for (const root of roots) {
  for (const style of root.querySelectorAll("style")) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style.textContent));
    blocks.push({ hash: "sha256-" + btoa(String.fromCharCode(...new Uint8Array(digest))), applied: Boolean(style.sheet) });
  }
}
const q = (selector) => document.querySelector(selector);
const outsiders = performance.getEntriesByType("resource").map((entry) => entry.name)
  .filter((name) => !name.startsWith(location.origin) && !/fonts\.(googleapis|gstatic)\.com/.test(name));
hit("distill/report/" + encodeURIComponent(JSON.stringify({
  blocks: blocks.length,
  unknown: [...new Set(blocks.filter((b) => !DISTILL_STYLE_HASHES.includes(b.hash)).map((b) => b.hash))],
  refused: blocks.filter((b) => !b.applied).length,
  slider: Math.round(q("d-slider").getBoundingClientRect().width),
  blockMath: getComputedStyle(q("d-math[block]")).display,
  hoverBox: getComputedStyle(q("d-footnote").shadowRoot.querySelector("d-hover-box")).display,
  title: getComputedStyle(q("d-title")).display,
  katex: typeof katex === "object" && Boolean(q("d-math").shadowRoot.querySelector(".katex")),
  outsiders,
})));
`;
let siteOrigin = "";
const routing = readRouting(JSON.parse(fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "vercel.json"),
  "utf8"
)));
const post = {
  slug: "policy-probe", title: "Policy probe",
  date: "2026-01-01T00:00:00.000Z", description: "",
  tags: [], readingTime: 1, math: false, html: "<p>Probe.</p>",
  styles: [], head: "", distill: false,
  scripts: ["/assets/posts/policy-probe.mjs", `${OUTSIDE}/outside.mjs`],
};

const site = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  const send = (type, body, headers = {}) => {
    res.writeHead(200, { "content-type": type, ...headers });
    res.end(body);
  };
  if (pathname.startsWith("/hit/")) {
    siteHits.push(pathname);
    res.writeHead(204).end();
    return;
  }
  if (pathname === "/api/public-data") return send("application/json", "{}");
  if (pathname.endsWith("/distill.template.v2.js")) {
    return send("text/javascript", fs.readFileSync(path.join(ENGINE, "assets", "vendor", "distill.template.v2.js")));
  }
  if (pathname === "/assets/vendor/katex.min.js") {
    siteHits.push(pathname);
    return send("text/javascript", fs.readFileSync(path.join(KATEX, "katex.min.js")));
  }
  if (pathname === "/styles/katex.min.css") return send("text/css", fs.readFileSync(path.join(KATEX, "katex.min.css")));
  if (pathname.startsWith("/styles/fonts/") && fs.existsSync(path.join(KATEX, "fonts", path.basename(pathname)))) {
    return send("font/woff2", fs.readFileSync(path.join(KATEX, "fonts", path.basename(pathname))));
  }
  if (pathname === "/lib/distill.mjs") return send("text/javascript", fs.readFileSync(path.join(ENGINE, "lib", "distill.mjs")));
  if (pathname === "/assets/posts/distill-probe.mjs") return send("text/javascript", DISTILL_PROBE);
  if (pathname === "/distill-probe/") {
    let policy = headersFor(routing, pathname).get("content-security-policy");
    // The control removes exactly the Distill hashes, and nothing else.
    if (distillControl) for (const hash of DISTILL_STYLE_HASHES) policy = policy.replace(` '${hash}'`, "");
    return send("text/html; charset=utf-8", postPage({
      ...post, slug: "distill-probe", title: "Distill probe", html: DISTILL_HTML, distill: true,
      scripts: ["/assets/posts/distill-probe.mjs"],
    }), { "content-security-policy": policy });
  }
  if (pathname === "/assets/blog.js") {
    return send("text/javascript", `new Image().src = "/hit/head/" +
      (document.documentElement.classList.contains("js") ? "js" : "no-js") + "-" +
      (document.documentElement.getAttribute("data-view") || "none");`);
  }
  if (pathname === "/assets/posts/policy-probe.mjs") {
    return send("text/javascript", `
      new Image().src = "/hit/self-module";
      fetch("/api/public-data").then(function () {
        new Image().src = "/hit/self-fetch";
      });
      fetch(${JSON.stringify(`${OUTSIDE}/data`)}).then(function () {
        new Image().src = "/hit/outside-fetch";
      }).catch(function () {
        new Image().src = "/hit/outside-blocked";
      });
    `);
  }
  let html = pathname === "/listing/" ? listPage([post]) : postPage(post);
  const policy = headersFor(routing, pathname).get("content-security-policy");
  send("text/html; charset=utf-8", html,
    !control && policy ? { "content-security-policy": policy } : {});
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
siteOrigin = `http://127.0.0.1:${site.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-public-csp-"));
const reader = await startPageReader(profile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function quiet() {
  let seen = -1;
  for (let i = 0; i < 20 && seen !== siteHits.length + outsideHits.length; i++) {
    seen = siteHits.length + outsideHits.length;
    await sleep(150);
  }
}
async function run(pathname, isControl = false, settle = quiet) {
  control = isControl;
  siteHits.length = 0;
  outsideHits.length = 0;
  try {
    await reader.read(`${siteOrigin}${pathname}`, { settle });
  } catch (err) {
    cannotRun("the public CSP probe could not load", err.message);
  }
  return { site: [...siteHits], outside: [...outsideHits] };
}

const checks = [];
const check = (name, ok, saw = "") => {
  checks.push(ok);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok && saw) console.log(`          saw: ${saw}`);
};

console.log(`${browserVersion()}\n`);
const configured = await run("/policy-probe/");
console.log("A generated post page, with its policy:");
if (!configured.site.includes("/hit/self-module")) {
  cannotRun("the same-origin module did not run", configured.site.join(", "));
}
check("same-origin scripts still run", configured.site.includes("/hit/self-module"));
check("same-origin data reads still work", configured.site.includes("/hit/self-fetch"));
check("a third-party module is not even requested",
  !configured.outside.includes("/outside.mjs"), configured.outside.join(", "));
check("a third-party data read is not even requested",
  !configured.outside.includes("/data"), configured.outside.join(", "));

const listing = await run("/listing/?view=table");
console.log("\nA listing page, whose two inline head scripts are hash-admitted:");
check("the JS marker and pre-paint view chooser both run",
  listing.site.includes("/hit/head/js-table"), listing.site.join(", "));

const noPolicy = await run("/policy-probe/", true);
console.log("\nControl, the same page with its policy removed:");
check("the outside module arrives — so the configured refusal was measured",
  noPolicy.outside.includes("/outside.mjs"), noPolicy.outside.join(", "));
check("the outside data arrives — so the configured refusal was measured",
  noPolicy.outside.includes("/data"), noPolicy.outside.join(", "));

console.log("\nThe Distill template on a public page, its style blocks allowed by hash:");
const distillReport = async () => {
  for (let i = 0; i < 70 && !siteHits.some((p) => p.startsWith("/hit/distill/report/")); i++) await sleep(150);
};
const reportOf = (hits) => {
  const found = hits.find((p) => p.startsWith("/hit/distill/report/"));
  return found ? JSON.parse(decodeURIComponent(found.slice("/hit/distill/report/".length))) : null;
};
const distill = await run("/distill-probe/", false, distillReport);
const report = reportOf(distill.site);
if (!report) cannotRun("the Distill probe did not report", distill.site.join(", "));
check("every style block the template injects is one the policy names",
  report.blocks > 0 && report.unknown.length === 0, JSON.stringify(report.unknown));
check("none of them is refused", report.refused === 0, `${report.refused} of ${report.blocks}`);
check("its slider, block maths, footnote box and title are laid out by their own styles",
  report.slider > 0 && report.blockMath === "block" && report.hoverBox === "none" && report.title === "grid",
  JSON.stringify(report));
check("<d-math> typesets with KaTeX served by this site",
  report.katex && distill.site.includes("/assets/vendor/katex.min.js"), distill.site.join(", "));
check("nothing is loaded from another site", report.outsiders.length === 0, report.outsiders.join(", "));

distillControl = true;
const withoutHashes = reportOf((await run("/distill-probe/", false, distillReport)).site);
distillControl = false;
console.log("\nControl, the same page without the Distill hashes:");
check("the same blocks are refused and the slider has no size — so the configured run was measured",
  withoutHashes && withoutHashes.refused > 0 && withoutHashes.slider === 0, JSON.stringify(withoutHashes));

await reader.close();
site.close();
outside.close();
fs.rmSync(profile, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} browser checks passed`);
process.exit(failed ? 1 : 0);
