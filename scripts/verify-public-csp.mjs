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
async function run(pathname, isControl = false) {
  control = isControl;
  siteHits.length = 0;
  outsideHits.length = 0;
  try {
    await reader.read(`${siteOrigin}${pathname}`, { settle: quiet });
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

await reader.close();
site.close();
outside.close();
fs.rmSync(profile, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} browser checks passed`);
process.exit(failed ? 1 : 0);
