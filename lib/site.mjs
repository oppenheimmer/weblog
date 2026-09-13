export const DEFAULT_SITE_URL = "https://blog.souravmishra.net";

/**
 * The public origin that pages, feeds and the sitemap name (CLAUDE.md §6).
 *
 * SITE_URL when it is set — the variable the origin allowlist and the
 * live-status check already read, so one value decides all three — else the
 * production address. Refused rather than repaired: a value that is not a bare
 * http(s) origin stops the build with its name, because a guessed canonical
 * URL would quietly move every page's identity.
 */
export function siteUrlFrom(value) {
  const raw = value === undefined || value === null ? "" : String(value).trim();
  if (raw === "") return DEFAULT_SITE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SITE_URL is not a URL: ${JSON.stringify(raw)}.`);
  }
  const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  if (!["https:", "http:"].includes(url.protocol) || !bare) {
    throw new Error(`SITE_URL must be an origin such as https://blog.example.com, ` +
      `with no path, query or credentials: ${JSON.stringify(raw)}.`);
  }
  return url.origin;
}
