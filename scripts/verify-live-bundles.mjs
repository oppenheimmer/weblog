// Reads back, from the live site, what §3.6 measured only locally: that the
// platform applies vercel.json's bundle rules to real published bundles, and
// that Run preview addresses reach the preview function (CLAUDE.md §3.6).
//
//   node scripts/verify-live-bundles.mjs                      # SITE_URL, else production
//   SITE_URL=https://blog.example node scripts/verify-live-bundles.mjs
//
// Anonymous GETs of public addresses only: no credentials, no writes. The Run
// preview addresses need only a deployment; the bundle rules need at least one
// published post using an interactive, and without one it exits 2, because the
// part that matters most measured nothing.
//
// Exit codes: 0 every check passed, 1 a check failed, 2 it could not run.
import { siteUrlFrom } from "../lib/templates.mjs";

const SITE = siteUrlFrom(process.env.SITE_URL);
const results = [];

function check(name, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail)})`}`);
}

async function get(path) {
  const url = new URL(path, SITE);
  // A random query keeps any cache from answering for the deployment.
  url.searchParams.set("verify", Math.random().toString(36).slice(2));
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.text();
  return { res, body, finalPath: new URL(res.url).pathname };
}

const header = (res, name) => res.headers.get(name);

let manifest;
try {
  const { res, body } = await get("/build-manifest.json");
  if (!res.ok) throw new Error(`build-manifest.json answered ${res.status}`);
  manifest = JSON.parse(body);
} catch (err) {
  console.log(`Cannot read ${SITE}/build-manifest.json: ${err.message}`);
  process.exit(2);
}

console.log(`${SITE}, commit ${manifest.commit ?? "unknown"}, ${manifest.posts?.length ?? 0} published post(s)`);

console.log("\nRun preview addresses (needs only a deployment):");
for (const path of ["/api/preview/run/not-a-grant/", "/api/preview/run/not-a-grant/lib/main.mjs"]) {
  const { res, body, finalPath } = await get(path);
  let code = null;
  try { code = JSON.parse(body).code; } catch { /* the platform's own page, not the function */ }
  check(`${path} reaches the preview function, which refuses it`,
    res.status === 404 && code === "not_found" && finalPath === path, { status: res.status, code, finalPath });
}

const found = [];
for (const post of manifest.posts ?? []) {
  const { body } = await get(`/${post.slug}/`);
  for (const match of body.matchAll(/data-interactive="(demo|figure)" data-interactive-src="([^"]+)"/g)) {
    found.push({ slug: post.slug, kind: match[1], src: match[2].replace(/&amp;/g, "&") });
  }
}
if (!found.length) {
  console.log("\nNo published post uses an interactive, so the bundle rules were not read back. Publish one, then run this again.");
  process.exit(results.every(Boolean) ? 2 : 1);
}

for (const { slug, kind, src } of found) {
  console.log(`\n/${slug}/ ${kind === "demo" ? "lab" : "figure"} ${src}`);
  if (kind === "demo") {
    const { res, body, finalPath } = await get(src);
    check("the lab's entry is served", res.status === 200 && /text\/html/.test(header(res, "content-type") ?? ""),
      { status: res.status, type: header(res, "content-type") });
    // cleanUrls may redirect the .html address; the lab's relative files only
    // resolve if it lands on its own directory.
    const directory = src.slice(0, src.lastIndexOf("/") + 1);
    check("it lands at its own directory, so ./ paths inside it resolve",
      finalPath === src || finalPath === directory, { finalPath });
    check("opened directly, its response sandboxes it", header(res, "content-security-policy") === "sandbox allow-scripts",
      header(res, "content-security-policy"));
    check("its opaque origin may read it", header(res, "access-control-allow-origin") === "*",
      header(res, "access-control-allow-origin"));

    const sibling = /\ssrc=["']?\.\/([A-Za-z0-9][A-Za-z0-9._/-]*)/.exec(body)?.[1];
    if (sibling) {
      const file = await get(`${directory}${sibling}`);
      check(`a file beside it (${sibling}) is served, readable by the lab`,
        file.res.status === 200 && header(file.res, "access-control-allow-origin") === "*",
        { status: file.res.status, acao: header(file.res, "access-control-allow-origin") });
    }
  } else {
    const { res } = await get(src);
    check("the figure's module is served as JavaScript", res.status === 200 &&
      /javascript/.test(header(res, "content-type") ?? ""), { status: res.status, type: header(res, "content-type") });
    check("its path carries the sandbox policy too", header(res, "content-security-policy") === "sandbox allow-scripts",
      header(res, "content-security-policy"));
    check("it is not readable by other origins", header(res, "access-control-allow-origin") === null,
      header(res, "access-control-allow-origin"));
  }
}

console.log("\nThe rest of the site:");
{
  const slug = found[0].slug;
  const { res } = await get(`/${slug}/`);
  const csp = header(res, "content-security-policy") ?? "";
  check("the post page has the public CSP, not a bundle's", /default-src 'none'/.test(csp) && !/sandbox/.test(csp), csp);
  check("the post page is not readable by other origins", header(res, "access-control-allow-origin") === null);
  const health = await get("/api/health/");
  check("the API is not readable by other origins", header(health.res, "access-control-allow-origin") === null);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} live checks passed`);
process.exit(failed ? 1 : 0);
