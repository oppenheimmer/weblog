// What `vercel.json` asks the platform to do with a public path (CLAUDE.md §3.6).
//
// Two callers need to agree about this and must not each keep their own copy:
// the tripwires that pin the header rules, and `scripts/verify-demo-sandbox.mjs`,
// which serves a local stand-in of the site so a real browser can be asked what
// those headers actually buy. A check that asserts against a hand-written copy
// of the config measures the copy.
//
// **This is a model, and the platform is the authority.** It covers the subset
// of `source` syntax this project uses and refuses anything outside it, so a
// rule it cannot represent stops the tests rather than quietly matching nothing.
// The remaining claim — that Vercel applies these headers to these static paths
// at all — is not something a local model can settle; it is confirmed on a real
// deployment when the first bundle ships.

/** The `source` shapes this model understands: literal segments, with `(.*)` as the only wildcard. */
const SUPPORTED_SOURCE = /^\/(?:[A-Za-z0-9\-._~/]|\(\.\*\))*$/;

export class RoutingError extends Error {
  constructor(message) {
    super(message);
    this.name = "RoutingError";
  }
}

const escapeLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile one rule's `source` into an anchored regular expression.
 *
 * Refuses what it cannot represent. Being unable to model a rule is a reason to
 * stop, not to return "no match": a silent non-match would turn a missing
 * security header into a passing test.
 */
export function compileSource(source) {
  if (typeof source !== "string" || !SUPPORTED_SOURCE.test(source)) {
    throw new RoutingError(
      `lib/routing.mjs cannot model the path pattern ${JSON.stringify(source)}. ` +
      `Teach it the syntax before relying on a test that matches against it.`
    );
  }
  const pattern = source.split("(.*)").map(escapeLiteral).join(".*");
  return new RegExp(`^${pattern}$`);
}

/** Read the routing configuration, with every rule's matcher already compiled. */
export function readRouting(config) {
  const rules = (config.headers ?? []).map((rule) => ({
    source: rule.source,
    match: compileSource(rule.source),
    headers: rule.headers ?? [],
  }));
  return {
    cleanUrls: config.cleanUrls === true,
    trailingSlash: config.trailingSlash === true,
    rules,
  };
}

/**
 * Every header the configuration applies to a path, lowercased by key.
 *
 * Later rules win on a repeated key, which is how Vercel resolves them.
 */
export function headersFor(routing, pathname) {
  const headers = new Map();
  for (const rule of routing.rules) {
    if (!rule.match.test(pathname)) continue;
    for (const { key, value } of rule.headers) headers.set(String(key).toLowerCase(), value);
  }
  return headers;
}

/**
 * The relative file a public path resolves to, under `cleanUrls` and `trailingSlash`.
 *
 * A bundle's own relative references depend on this: `/demos/<post>/<lab>/<rev>/`
 * must serve `index.html` *at that path*, or `./demo.mjs` beside it resolves one
 * directory too high. Returns null for a path this configuration would not serve
 * as a file.
 */
export function fileFor(routing, pathname) {
  if (!pathname.startsWith("/")) return null;
  const clean = decodeURIComponent(pathname);
  if (clean.includes("..")) return null;
  if (clean.endsWith("/")) return `${clean.slice(1)}index.html`;
  if (routing.cleanUrls && !clean.split("/").pop().includes(".")) return `${clean.slice(1)}.html`;
  return clean.slice(1);
}
