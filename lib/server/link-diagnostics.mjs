import { internalLinkDiagnostics } from "../link-diagnostics.mjs";
import { normalizePost } from "../content.mjs";
import { inspectHtml } from "../structure.mjs";
import { SITE } from "../templates.mjs";
import { keys } from "./keys.mjs";

/** Preview reads only publications actually linked to, and renders a target only for an anchor check. */
export async function previewLinkDiagnostics(store, post) {
  let index;
  return internalLinkDiagnostics(post, { origin: SITE.url, resolve: async (path, { anchors }) => {
    if (["/", "/feed.xml", "/sitemap.xml", "/robots.txt", "/404.html", "/build-manifest.json"].includes(path)) {
      return { exists: true, ids: null };
    }
    // The build checks these against its complete emitted file set.
    if (/^\/(?:tags|page|images|assets|styles|demos|api|editor|login)(?:\/|$)/.test(path)) return null;
    index ??= (await store.getJson(keys.publishedIndex))?.data ?? { posts: {} };
    const slug = /^\/([^/]+)\/$/.exec(path)?.[1];
    const entry = slug ? index.posts?.[slug] : null;
    if (!entry) return { exists: false };
    if (!anchors) return { exists: true, ids: null };
    const record = await store.getJson(keys.publishedRevision(entry.postId, entry.revisionId));
    if (!record) return { exists: false };
    const r = record.data;
    const rendered = normalizePost({ data: r, body: r.body, format: r.format, sourceName: slug });
    const ids = inspectHtml(rendered.html).ids;
    ids.add("main-content"); ids.add("mobile-menu");
    return { exists: true, ids };
  } });
}
