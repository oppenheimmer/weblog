// RSS feed, sitemap, and robots.txt builders — plain string templates, no dependencies.
import { SITE, escapeHtml } from "./templates.mjs";

function xmlEscape(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function rss(posts) {
  const items = posts
    .map((p) => {
      const url = `${SITE.url}/${p.slug}/`;
      return `    <item>
      <title>${xmlEscape(p.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${new Date(p.date).toUTCString()}</pubDate>
      <description>${xmlEscape(p.description)}</description>
${(p.tags || []).map((t) => `      <category>${xmlEscape(t)}</category>`).join("\n")}
    </item>`;
    })
    .join("\n");

  const lastBuild = posts.length ? new Date(posts[0].date).toUTCString() : new Date().toUTCString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(SITE.title)}</title>
    <link>${SITE.url}/</link>
    <atom:link href="${SITE.url}/feed.xml" rel="self" type="application/rss+xml" />
    <description>${xmlEscape(SITE.description)}</description>
    <language>${SITE.lang}</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

export function sitemap(posts, extraPaths = []) {
  const urls = [
    { loc: `${SITE.url}/`, lastmod: posts[0]?.date },
    ...posts.map((p) => ({ loc: `${SITE.url}/${p.slug}/`, lastmod: p.date })),
    ...extraPaths.map((p) => ({ loc: `${SITE.url}${p}` })),
  ];
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>${
          u.lastmod ? `\n    <lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod>` : ""
        }\n  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

export function robots() {
  return `User-agent: *
Allow: /

Sitemap: ${SITE.url}/sitemap.xml
`;
}

// re-export so build.mjs can use a single import surface if desired
export { escapeHtml };
