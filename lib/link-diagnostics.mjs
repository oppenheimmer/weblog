import { inspectHtml } from "./structure.mjs";

export function routePath(pathname) {
  let path;
  try { path = decodeURIComponent(pathname); } catch { return pathname; }
  if (path.endsWith("/index.html")) path = path.slice(0, -10);
  if (!path.endsWith("/") && !path.split("/").at(-1).includes(".")) path += "/";
  return path;
}

/** Local, nonblocking diagnostics. `resolve` supplies known routes and static ids. */
export async function internalLinkDiagnostics(post, { origin, resolve }) {
  const current = new URL(`/${post.slug}/`, origin);
  const { ids, links } = inspectHtml(post.html);
  ids.add("main-content"); ids.add("mobile-menu");
  const warnings = new Map(), targets = new Map();
  for (const href of links) {
    let url;
    try { url = new URL(href, current); } catch { continue; }
    if (url.origin !== current.origin || !["http:", "https:"].includes(url.protocol)) continue;
    const path = routePath(url.pathname);
    let target;
    if (path === current.pathname) target = { exists: true, ids };
    else {
      const key = `${path}:${url.hash ? "anchors" : "route"}`;
      if (!targets.has(key)) targets.set(key, await resolve(path, { anchors: Boolean(url.hash) }));
      target = targets.get(key);
    }
    if (!target) continue; // The preview cannot verify every generated/asset route.
    let code, message;
    if (!target.exists) {
      code = "missing_internal_route"; message = `Internal link ${href} points to a page or file that is not published.`;
    } else if (url.hash && target.ids) {
      let fragment;
      const anchor = url.hash.slice(1).split(":~:")[0];
      try { fragment = decodeURIComponent(anchor); } catch { fragment = anchor; }
      if (fragment && fragment.toLowerCase() !== "top" && !target.ids.has(fragment)) {
        code = "missing_internal_anchor"; message = `Internal link ${href} points to a missing heading or anchor.`;
      }
    }
    if (code && warnings.size < 100) warnings.set(`${code}:${href}`, { level: "warning", code, subject: href, message });
  }
  return [...warnings.values()];
}
