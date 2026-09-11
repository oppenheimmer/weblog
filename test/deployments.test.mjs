// Tier 5 — reading back what the site shows (CLAUDE.md Step 7).
//
// "Live" is a claim about the public site, so it is decided from the manifest
// the site serves and nothing weaker. These pin the decision table and the
// fetch that feeds it.
import test from "node:test";
import assert from "node:assert/strict";

import { readSiteManifest, siteStatus, siteOrigin, MANIFEST_PATH } from "../lib/server/deployments.mjs";

const A = "p_00000000000000aa";
const served = (posts, commit = "c1") => ({ ok: true, commit, posts });
const publication = (over = {}) => ({ postId: A, published: true, slug: "a-post", revisionId: "r_000002_x_1", ...over });
const offSite = { published: false, revisionId: null };

test("a post is live only when the served manifest names its current revision at its address", () => {
  const current = { slug: "a-post", postId: A, revisionId: "r_000002_x_1" };
  for (const [pub, manifest, expected] of [
    [publication(), served([current]), "live"],
    [publication(), served([{ ...current, revisionId: "r_000001_x_1" }]), "updating"],
    [publication(), served([{ ...current, slug: "old-address" }]), "updating"],
    [publication(), served([]), "pending"],
    [publication(offSite), served([current]), "removing"],
    [publication(offSite), served([]), "offline"],
    [publication(), { ok: false, checkable: true, reason: "down" }, "unknown"],
    [publication(offSite), { ok: false, checkable: false, reason: "nowhere" }, "unknown"],
  ]) {
    assert.equal(siteStatus(pub, manifest).state, expected, JSON.stringify({ pub, manifest }));
  }
});

test("another post at the same address does not make this one live", () => {
  // Matched by post id: a slug can pass from one post to another.
  const other = { slug: "a-post", postId: "p_00000000000000bb", revisionId: "r_000002_x_1" };
  assert.equal(siteStatus(publication(), served([other])).state, "pending");
});

test("the revision the site shows is reported alongside the state", () => {
  const older = { slug: "a-post", postId: A, revisionId: "r_000001_x_1" };
  assert.deepEqual(siteStatus(publication(), served([older])), { state: "updating", revisionId: "r_000001_x_1" });
});

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test("the manifest is read fresh from the public site, never from a cache", async () => {
  const seen = [];
  const fetch = async (url, options = {}) => {
    seen.push({ url: new URL(url), options });
    return json({ commit: "c7", posts: [{ slug: "a-post", postId: A, revisionId: "r_1" }] });
  };

  const result = await readSiteManifest({ origin: "https://blog.example", fetch });
  assert.deepEqual(result, { ok: true, commit: "c7", posts: [{ slug: "a-post", postId: A, revisionId: "r_1" }] });
  await readSiteManifest({ origin: "https://blog.example", fetch });

  const [first, second] = seen;
  assert.equal(`${first.url.origin}${first.url.pathname}`, `https://blog.example${MANIFEST_PATH}`);
  assert.equal(first.options.cache, "no-store");
  assert.match(first.url.searchParams.get("fresh") ?? "", /^[0-9a-f]{12}$/);
  assert.notEqual(first.url.href, second.url.href, "two checks shared a URL, so a cache keyed by it could answer");
});

test("a site that cannot be read is unknown, with a reason, and never an empty site", async () => {
  for (const [fetch, reason] of [
    [async () => new Response("unavailable", { status: 503 }), /answered 503/],
    [async () => new Response("<!doctype html>", { status: 200 }), /could not be read/],
    [async () => json({ commit: "c1" }), /could not be read/],
    [async () => { throw new TypeError("fetch failed"); }, /could not be reached/],
    [(url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    }), /did not answer in time/],
  ]) {
    const result = await readSiteManifest({ origin: "https://blog.example", fetch, timeoutMs: 20 });
    assert.deepEqual([result.ok, result.checkable], [false, true]);
    assert.match(result.reason, reason);
    assert.ok(!("posts" in result), "an unreadable site was reported as one with no posts");
  }
});

test("with no public site to ask, the check says so and fetches nothing", async () => {
  let fetched = false;
  const result = await readSiteManifest({ origin: null, fetch: async () => { fetched = true; } });
  assert.deepEqual([result.ok, result.checkable, fetched], [false, false, false]);
});

test("the site checked is SITE_URL, else the production address, else none", () => {
  assert.equal(siteOrigin({ url: "https://example.test/", production: false }), "https://example.test");
  assert.equal(siteOrigin({ url: "", production: true }), "https://blog.souravmishra.net");
  assert.equal(siteOrigin({ url: "", production: false }), null);
});
