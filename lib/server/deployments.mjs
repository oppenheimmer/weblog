// Whether the site shows what R2 says is published (CLAUDE.md Step 7).
//
// A published post is durable in R2 at once, but readers see it only after a
// build has run and been promoted. So "live" is read back from the deployment
// itself. Every build writes a public manifest naming the revisions it holds
// (build.mjs), and a post is live exactly when the manifest the site is serving
// names its current revision. A hook that answered, or a build that finished,
// is a weaker claim and is never reported as this one.
//
// Nothing here needs a Vercel token, and nothing is believed that the public
// site does not itself show.
import crypto from "node:crypto";

import { isProduction } from "./http.mjs";
import { SITE } from "../templates.mjs";

export const MANIFEST_PATH = "/build-manifest.json";
export const MANIFEST_TIMEOUT_MS = 5000;

/** The public site to check: SITE_URL, else the production address. None in a preview or a local run. */
export function siteOrigin({ url = process.env.SITE_URL, production = isProduction() } = {}) {
  if (url) return url.replace(/\/+$/, "");
  return production ? SITE.url : null;
}

/**
 * The build manifest the public site is serving right now.
 *
 * Returns `{ ok: true, commit, posts }`, or `{ ok: false, checkable, reason }`
 * when it cannot be read — which callers show as unknown, never as a guess.
 * `checkable: false` means there is no site to ask, so asking again is pointless.
 */
export async function readSiteManifest({
  origin = siteOrigin(),
  fetch = globalThis.fetch,
  timeoutMs = MANIFEST_TIMEOUT_MS,
} = {}) {
  if (!origin) return { ok: false, checkable: false, reason: "there is no public site to check from here" };

  const url = new URL(MANIFEST_PATH, `${origin}/`);
  // A copy cached anywhere between here and the deployment would report a new
  // post missing after it went live, or a removed one as still there.
  url.searchParams.set("fresh", crypto.randomBytes(6).toString("hex"));
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, checkable: true, reason: `the site answered ${res.status}` };
    const manifest = await res.json().catch(() => null);
    if (!Array.isArray(manifest?.posts)) {
      return { ok: false, checkable: true, reason: "the site's build manifest could not be read" };
    }
    return { ok: true, commit: typeof manifest.commit === "string" ? manifest.commit : null, posts: manifest.posts };
  } catch (err) {
    return {
      ok: false,
      checkable: true,
      reason: err?.name === "TimeoutError" ? "the site did not answer in time" : "the site could not be reached",
    };
  }
}

/**
 * What readers see of one publication, given the manifest being served.
 *
 *   live      the site shows the revision the index names, at its address
 *   updating  the site still shows another revision of the post
 *   pending   the site does not show the post yet
 *   removing  unpublished, but the site still shows it
 *   offline   unpublished, and gone from the site
 *   unknown   the manifest could not be read
 */
export function siteStatus(publication, manifest) {
  if (!manifest?.ok) return { state: "unknown", revisionId: null };
  const served = manifest.posts.find((post) => post?.postId === publication.postId);
  const revisionId = served?.revisionId ?? null;
  if (!publication.published) return { state: served ? "removing" : "offline", revisionId };
  if (!served) return { state: "pending", revisionId };
  const current = served.revisionId === publication.revisionId && served.slug === publication.slug;
  return { state: current ? "live" : "updating", revisionId };
}
