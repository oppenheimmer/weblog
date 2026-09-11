// HTML templates as plain template-literal functions (no templating dependency).
// Chrome (head, header/nav, footer, SVG sprite) is ported from the main site for visual parity.
import { attachmentUrl } from "./attachments.mjs";
import { inlinesInFeed } from "./listing.mjs";
import { prepareArticle } from "./markup.mjs";

export const SITE = {
  title: "Weblog",
  author: "Sourav Mishra",
  role: "ML Engineer, Computer Science Researcher",
  description:
    "Notes on CS, ML and some Math.",
  url: "https://blog.souravmishra.net", // no trailing slash
  mainSite: "https://souravmishra.net/",
  lang: "en",
  locale: "en_US",
  twitter: "@srvmshr",
  social: [
    { id: "icon-linkedin", label: "LinkedIn profile", href: "https://www.linkedin.com/in/srvmshr/", rel: "noopener noreferrer" },
    { id: "icon-github", label: "GitHub profile", href: "https://github.com/oppenheimmer", rel: "noopener noreferrer" },
    { id: "icon-mastodon", label: "Mastodon profile", href: "https://sigmoid.social/@sourav", rel: "me noopener noreferrer" },
    { id: "icon-bluesky", label: "Bluesky profile", href: "https://bsky.app/profile/souravmishra.bsky.social", rel: "noopener noreferrer" },
    { id: "icon-xsocial", label: "X profile", href: "https://x.com/srvmshr", rel: "noopener noreferrer" },
  ],
};

export function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatDate(iso) {
  const d = new Date(iso);
  // Dates are authored date-only and normalized to UTC midnight, so the display
  // must be read back in UTC too. Without this the local timezone of whoever
  // runs the build shifts every post a day earlier west of Greenwich.
  return d.toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

// JSON-LD sits inside a <script> element, where the HTML parser hunts for
// "</script" before it ever considers JSON syntax. Escaping the characters that
// could terminate the element keeps post metadata from breaking out of it.
export function jsonLdScript(data) {
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script type="application/ld+json">${json}</script>`;
}

// Shared URL-slug normalizer: lowercase, non-alphanumerics -> "-", trim dashes.
// Used for both filename-derived post slugs (build.mjs) and tag-page slugs.
export function slugify(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export const tagSlug = slugify;

// Inline SVG symbol sprite (subset of the main site's, plus social + menu icons).
function sprite() {
  return `
    <svg class="svg-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <symbol id="icon-linkedin" viewBox="0 0 448 512"><path fill="currentColor" d="M100.28 448H7.4V148.9h92.88zM53.79 108.1C24.09 108.1 0 83.5 0 53.8a53.79 53.79 0 0 1 107.58 0c0 29.7-24.1 54.3-53.79 54.3zM447.9 448h-92.68V302.4c0-34.7-.7-79.2-48.29-79.2-48.29 0-55.69 37.7-55.69 76.7V448h-92.78V148.9h89.08v40.8h1.3c12.4-23.5 42.69-48.3 87.88-48.3 94 0 111.28 61.9 111.28 142.3V448z"/></symbol>
      <symbol id="icon-github" viewBox="0 0 496 512"><path fill="currentColor" d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6-3.3.3-5.6-1.3-5.6-3.6 0-2 2.3-3.6 5.2-3.6 3-.3 5.6 1.3 5.6 3.6zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9 2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3zm44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9.3 2 2.9 3.3 5.9 2.6 2.9-.7 4.9-2.6 4.6-4.6-.3-1.9-3-3.2-5.9-2.9zM244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2 12.8 2.3 17.3-5.6 17.3-12.1 0-6.2-.3-40.4-.3-61.4 0 0-70 15-84.7-29.8 0 0-11.4-29.1-27.8-36.6 0 0-22.9-15.7 1.6-15.4 0 0 24.9 2 38.6 25.8 21.9 38.6 58.6 27.5 72.9 20.9 2.3-16 8.8-27.1 16-33.7-55.9-6.2-112.3-14.3-112.3-110.5 0-27.5 7.6-41.3 23.6-58.9-2.6-6.5-11.1-33.3 2.6-67.9 20.9-6.5 69 27 69 27 20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27 13.7 34.7 5.2 61.4 2.6 67.9 16 17.7 25.8 31.5 25.8 58.9 0 96.5-58.9 104.2-114.8 110.5 9.2 7.9 17 22.9 17 46.4 0 33.7-.3 75.4-.3 83.6 0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252 496 113.3 383.5 8 244.8 8z"/></symbol>
      <symbol id="icon-mastodon" viewBox="0 0 448 512"><path fill="currentColor" d="M433 179.11c0-97.2-63.71-125.7-63.71-125.7-62.52-28.7-228.56-28.4-290.48 0 0 0-63.72 28.5-63.72 125.7 0 115.7-6.6 259.4 105.63 289.1 40.51 10.7 75.32 13 103.33 11.4 50.81-2.8 79.32-18.1 79.32-18.1l-1.7-36.9s-36.31 11.4-77.12 10.1c-40.41-1.4-83-4.4-89.63-54a102.54 102.54 0 0 1-.9-13.9c85.63 20.9 158.65 9.1 178.75 6.7 56.12-6.7 105-41.3 111.23-72.9 9.8-49.8 9-121.5 9-121.5zm-75.12 125.2h-46.63v-114.2c0-49.7-64-51.6-64 6.9v62.5h-46.33V197c0-58.5-64-56.6-64-6.9v114.2H90.19c0-122.1-5.2-147.9 18.41-175 25.9-28.9 79.82-30.8 103.83 6.1l11.6 19.5 11.6-19.5c24.11-37.1 78.12-34.8 103.83-6.1 23.71 27.3 18.4 53 18.4 175z"/></symbol>
      <symbol id="icon-bluesky" viewBox="0 0 512 512"><path fill="currentColor" d="M111.8 62.2C170.2 105.9 233 194.7 256 242.4c23-47.6 85.8-136.4 144.2-180.2c42.1-31.6 110.3-56 110.3 21.8c0 15.5-8.9 130.5-14.1 149.2C478.2 298 412 314.6 353.1 304.5c102.9 17.5 129.1 75.5 72.5 133.5c-107.4 110.2-154.3-27.6-166.3-62.9c-1.7-4.9-2.6-7.8-3.3-7.8s-1.6 3-3.3 7.8c-12 35.3-59 173.1-166.3 62.9c-56.5-58-30.4-116 72.5-133.5C100 314.6 33.8 298 15.7 233.1C10.4 214.4 1.5 99.4 1.5 83.9c0-77.8 68.2-53.4 110.3-21.8z"/></symbol>
      <symbol id="icon-xsocial" viewBox="0 0 512 512"><path fill="currentColor" d="M389.2 48h70.6L305.6 224.2 487 464H345L233.7 318.6 106.5 464H35.8L200.7 275.5 26.8 48H172.4L272.9 180.9 389.2 48zM364.4 421.8h39.1L151.1 88h-42L364.4 421.8z"/></symbol>
      <symbol id="icon-bars" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="icon-xmark" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
      <symbol id="icon-arrow-left" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    </svg>`;
}

function socialLinks() {
  return SITE.social
    .map(
      (s) => `
        <a href="${s.href}" target="_blank" rel="${s.rel}" aria-label="${s.label}" class="icon-link">
          <svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24"><use href="#${s.id}"></use></svg>
        </a>`
    )
    .join("");
}

function header() {
  return `
    <header class="site-header">
      <div class="shell">
        <div class="nav-bar">
          <a class="brand-copy" href="/" aria-label="Blog home">
            <span class="brand-mark" aria-hidden="true">SM</span>
            <span class="brand-text">
              <span class="brand-name">Sourav Mishra</span>
              <span class="brand-role">Writing &amp; Notes</span>
            </span>
          </a>

          <nav class="nav-links" aria-label="Primary">
            <a href="${SITE.mainSite}" class="nav-link">Home</a>
            <a href="/" class="nav-link">Blog</a>
          </nav>

          <div class="social-links" aria-label="Social links">${socialLinks()}</div>

          <button id="mobile-menu-btn" class="menu-toggle" type="button" aria-expanded="false"
            aria-controls="mobile-menu" aria-label="Open navigation menu">
            <svg id="mobile-menu-icon-open" class="icon-svg menu-icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#icon-bars"></use></svg>
            <svg id="mobile-menu-icon-close" class="icon-svg menu-icon" aria-hidden="true" viewBox="0 0 24 24" hidden><use href="#icon-xmark"></use></svg>
          </button>
        </div>

        <div id="mobile-menu" class="mobile-menu" hidden>
          <nav aria-label="Mobile" data-clone-source="nav-links"></nav>
          <div class="mobile-social" aria-label="Mobile social links" data-clone-source="social-links"></div>
        </div>
      </div>
    </header>`;
}

function footer() {
  return `
    <footer class="site-footer">
      <div class="shell">
        <div class="footer-card">
          <p>&copy; <span id="copyright-year"></span> ${SITE.author}</p>
          <p><a href="/feed.xml">RSS</a> &middot; <a href="${SITE.mainSite}">souravmishra.net</a></p>
        </div>
      </div>
    </footer>`;
}

/** Where a reader's choice of listing view is remembered, in their own browser. */
export const VIEW_STORAGE_KEY = "blog:view";

// Chooses the listing view before the body is parsed, so a reader who prefers
// the table never sees the feed flash first. A `?view=` in the address wins for
// that visit; otherwise the remembered choice; otherwise the feed. Anything
// unrecognised, and storage the browser refuses, falls through to the next
// option rather than throwing. Only the table is marked: with no attribute —
// no script, or nothing chosen — the feed shows, which is also the no-script
// experience.
const VIEW_SCRIPT = `<script>(function(){var v=null;try{v=new URLSearchParams(location.search).get("view")}catch(e){}if(v!=="feed"&&v!=="table"){try{v=localStorage.getItem("${VIEW_STORAGE_KEY}")}catch(e){v=null}}if(v==="table")document.documentElement.setAttribute("data-view","table")})();</script>`;

// Full HTML document shell. `head` is raw extra head markup; `bodyEnd` is raw
// markup appended after the site script (per-post module scripts); `bodyClass`
// styles the page; `views` adds the listing view chooser.
function shell({ title, description, canonical, math = false, head = "", bodyEnd = "", bodyClass = "", views = false, body }) {
  const katexCss = math
    ? `\n  <link rel="stylesheet" href="/styles/katex.min.css" />`
    : "";
  return `<!DOCTYPE html>
<html lang="${SITE.lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script>document.documentElement.classList.add("js");</script>${views ? `\n  ${VIEW_SCRIPT}` : ""}
  <meta name="description" content="${escapeHtml(description)}" />
  <meta name="theme-color" content="#12344d" />
  <link rel="canonical" href="${canonical}" />
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/styles/blog.css" />
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(SITE.title)}" href="/feed.xml" />${katexCss}
${head}
</head>
<body class="${bodyClass}">
  <a class="skip-link" href="#main-content">Skip to main content</a>
  ${sprite()}
  ${header()}
  <main id="main-content">
${body}
  </main>
  ${footer()}
  <script src="/assets/blog.js"></script>${bodyEnd}
</body>
</html>
`;
}

// Per-post asset hooks driven by frontmatter: `styles` (head stylesheets),
// `scripts` (deferred ES modules at body end), `head` (raw head markup), and
// `distill: true` (load the self-hosted distill component library).
const DISTILL_SCRIPT = "/assets/vendor/distill.template.v2.js";

function postAssets(post) {
  const styles = (post.styles || [])
    .map((href) => `\n  <link rel="stylesheet" href="${href}" />`)
    .join("");
  const scripts = (post.scripts || [])
    .map((src) => `\n  <script type="module" src="${src}" defer></script>`)
    .join("");
  const distillHead = post.distill
    ? `\n  <script src="${DISTILL_SCRIPT}"></script>`
    : "";
  const rawHead = post.head ? `\n  ${post.head}` : "";
  return {
    head: `${styles}${distillHead}${rawHead}`,
    bodyEnd: scripts,
  };
}

// ---- Page builders -------------------------------------------------------

function postMetaTags(post) {
  const url = `${SITE.url}/${post.slug}/`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.date,
    author: { "@type": "Person", name: SITE.author, url: SITE.mainSite },
    publisher: { "@type": "Person", name: SITE.author },
    mainEntityOfPage: url,
    keywords: (post.tags || []).join(", "),
  };
  return `
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="${escapeHtml(SITE.title)}" />
  <meta property="og:title" content="${escapeHtml(post.title)}" />
  <meta property="og:description" content="${escapeHtml(post.description)}" />
  <meta property="og:url" content="${url}" />
  <meta property="article:published_time" content="${post.date}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(post.title)}" />
  <meta name="twitter:description" content="${escapeHtml(post.description)}" />
  <meta name="twitter:creator" content="${SITE.twitter}" />
  ${jsonLdScript(ld)}`;
}

function tagChips(tags = []) {
  if (!tags.length) return "";
  return `<div class="chip-row" aria-label="Tags">${tagLinks(tags)}</div>`;
}

const tagLinks = (tags) =>
  tags.map((t) => `<a class="chip" href="/tags/${tagSlug(t)}/">${escapeHtml(t)}</a>`).join("");

/** Dimensions of the images a post's media manifest names, by public URL. */
function mediaSizes(post) {
  if (!post.media?.length) return null;
  return new Map(post.media.map((m) => [attachmentUrl(post.slug, m.publicName), { width: m.width, height: m.height }]));
}

/**
 * A post's body as its own page shows it. Identical to the rendered HTML except
 * that images named in the post's media manifest carry their dimensions.
 */
function pageBody(post) {
  return prepareArticle(post.html, { sizes: mediaSizes(post) });
}

// The compact view: one row per post, in a native table so title, date and tags
// stay associated for assistive technology. The title is the row header, so a
// screen reader moving along a row hears which post it is in. On a narrow screen
// the table scrolls sideways inside its frame instead of dissolving into stacked
// blocks, which is what used to lose the column relationships.
function postTable(posts) {
  const rows = posts
    .map(
      (p) => `
              <tr>
                <th scope="row" class="post-table-title"><a href="/${p.slug}/">${escapeHtml(p.title)}</a></th>
                <td class="post-table-date"><time datetime="${p.date}">${formatDate(p.date)}</time></td>
                <td class="post-table-tags">${tagLinks(p.tags)}</td>
              </tr>`
    )
    .join("");
  return `
          <div class="post-table-frame">
            <table class="post-table">
              <thead>
                <tr><th scope="col">Title</th><th scope="col">Date</th><th scope="col">Tags</th></tr>
              </thead>
              <tbody>${rows}
              </tbody>
            </table>
          </div>`;
}

/**
 * One post as the feed shows it: the whole article.
 *
 * Its ids are prefixed with its slug so it can sit beside other posts, and its
 * section links point at its own page. A post whose embeds need the page to
 * itself is summarised and linked instead (lib/listing.mjs).
 */
export function feedArticle(post, { lazy = true } = {}) {
  const url = `/${post.slug}/`;
  const header = `
            <header class="feed-header">
              <div class="post-meta">
                <time datetime="${post.date}">${formatDate(post.date)}</time>
                <span aria-hidden="true">&middot;</span>
                <span>${post.readingTime} min read</span>
              </div>
              <h2 class="feed-title"><a href="${url}">${escapeHtml(post.title)}</a></h2>
              ${tagChips(post.tags)}
            </header>`;

  if (!inlinesInFeed(post)) {
    return `
          <article class="feed-post fade-up">${header}
            <p class="post-lede">${escapeHtml(post.description)}</p>
            <p class="feed-note">This post has interactive parts that run only on its own page.</p>
            <p class="feed-more"><a class="button button-secondary" href="${url}">Read the post</a></p>
          </article>`;
  }

  const body = prepareArticle(post.html, {
    idPrefix: post.slug,
    sizes: mediaSizes(post),
    lazy,
    permalinks: { className: "heading-anchor", base: url },
  });
  return `
          <article class="feed-post fade-up">${header}
            <div class="prose">
${body}
            </div>
          </article>`;
}

/** What one post adds to a feed page, in bytes: the measure pagination uses. */
export function feedWeight(post) {
  return Buffer.byteLength(feedArticle(post), "utf8");
}

function viewSwitch() {
  // Hidden until script is present (blog.css), since only script can switch.
  return `
            <div class="view-switch" role="group" aria-label="Show posts as">
              <button type="button" class="view-option" data-view-option="feed" aria-pressed="true">Feed</button>
              <button type="button" class="view-option" data-view-option="table" aria-pressed="false">Table</button>
            </div>`;
}

function pager(page) {
  if (page.count < 2) return "";
  const link = (href, rel, label) => href
    ? `<a class="button button-secondary" href="${href}" rel="${rel}">${label}</a>`
    : `<span class="pager-gap" aria-hidden="true"></span>`;
  return `
            <nav class="pager" aria-label="More posts">
              ${link(page.newer, "prev", "Newer posts")}
              <span class="pager-status">Page ${page.number} of ${page.count}</span>
              ${link(page.older, "next", "Older posts")}
            </nav>`;
}

/**
 * The two views of one listing page. Both are in the HTML; blog.css shows one
 * (the feed unless the reader chose the table) and hides the other completely,
 * so the hidden one takes no part in focus or the accessibility tree.
 */
function listingViews(all, page) {
  const articles = page.posts.map((post, index) => feedArticle(post, { lazy: index > 0 })).join("");
  return `
          <div class="listing-view listing-feed">${articles}${pager(page)}
          </div>
          <div class="listing-view listing-table">${postTable(all)}
          </div>`;
}

/** A single page holding the whole scope, for callers that do not paginate. */
function onePage(posts, base) {
  return { number: 1, count: 1, path: base, base, posts, newer: null, older: null };
}

const pageMath = (page) => page.posts.some((post) => post.math && inlinesInFeed(post));
const pageSuffix = (page) => (page.number > 1 ? `, page ${page.number}` : "");

export function postPage(post) {
  const body = `
    <article class="section post">
      <div class="shell">
        <a class="back-link fade-up" href="/">
          <svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24"><use href="#icon-arrow-left"></use></svg>
          All posts
        </a>
        <header class="post-header fade-up">
          <div class="post-meta">
            <time datetime="${post.date}">${formatDate(post.date)}</time>
            <span aria-hidden="true">&middot;</span>
            <span>${post.readingTime} min read</span>
          </div>
          <h1 class="post-title">${escapeHtml(post.title)}</h1>
          <p class="post-lede">${escapeHtml(post.description)}</p>
          ${tagChips(post.tags)}
        </header>
        <div class="prose fade-up">
${pageBody(post)}
        </div>
      </div>
    </article>`;
  const assets = postAssets(post);
  return shell({
    title: `${post.title} — ${SITE.author}`,
    description: post.description,
    canonical: `${SITE.url}/${post.slug}/`,
    math: post.math,
    head: postMetaTags(post) + assets.head,
    bodyEnd: assets.bodyEnd,
    bodyClass: `blog-page post-page${post.distill ? " distill-page" : ""}`,
    body,
  });
}

/**
 * One page of the home listing. `posts` is every post, which the table lists;
 * `page` says which of them this page's feed shows (lib/listing.mjs).
 */
export function listPage(posts, page = onePage(posts, "/")) {
  const content = posts.length
    ? `
          <div class="listing-bar fade-up">
            <h1 class="listing-heading">${page.number > 1 ? `Posts, page ${page.number}` : "Posts"}</h1>${viewSwitch()}
          </div>${listingViews(posts, page)}`
    : `
          <h1 class="listing-heading">Posts</h1>
          <p class="empty-state">No posts yet — check back soon.</p>`;
  const body = `
    <section class="section listing">
      <div class="shell">${content}
      </div>
    </section>`;

  const url = `${SITE.url}${page.path}`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: SITE.title,
    url: `${SITE.url}/`,
    author: { "@type": "Person", name: SITE.author, url: SITE.mainSite },
    blogPost: posts.map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      datePublished: p.date,
      url: `${SITE.url}/${p.slug}/`,
    })),
  };

  const title = page.number > 1 ? `Page ${page.number} — ${SITE.title}` : SITE.title;
  return shell({
    title,
    description: SITE.description,
    canonical: url,
    math: pageMath(page),
    views: posts.length > 0,
    bodyClass: "blog-page list-page",
    head: `
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${escapeHtml(SITE.title)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(SITE.description)}" />
  <meta property="og:url" content="${url}" />${page.number === 1 ? `
  ${jsonLdScript(ld)}` : ""}`,
    body,
  });
}

/** One page of a tag's listing: `posts` is everything with the tag. */
export function tagPage(tag, posts, page = onePage(posts, `/tags/${tagSlug(tag)}/`)) {
  const count = posts.length;
  const body = `
    <section class="section listing">
      <div class="shell">
        <a class="back-link fade-up" href="/">
          <svg class="icon-svg" aria-hidden="true" viewBox="0 0 24 24"><use href="#icon-arrow-left"></use></svg>
          All posts
        </a>
        <header class="tag-header fade-up">
          <div class="eyebrow">Tag</div>
          <h1 class="post-title">${escapeHtml(tag)}</h1>
          <div class="listing-bar">
            <p class="post-lede">${count} post${count === 1 ? "" : "s"} tagged &ldquo;${escapeHtml(tag)}&rdquo;${page.number > 1 ? `, page ${page.number} of ${page.count}` : ""}.</p>${viewSwitch()}
          </div>
        </header>${listingViews(posts, page)}
      </div>
    </section>`;
  return shell({
    title: `Posts tagged "${tag}"${pageSuffix(page)} — ${SITE.title}`,
    description: `All blog posts tagged "${tag}"`,
    canonical: `${SITE.url}${page.path}`,
    math: pageMath(page),
    views: true,
    bodyClass: "blog-page list-page tag-page",
    body,
  });
}

export function notFoundPage() {
  const body = `
    <section class="section hero" aria-labelledby="nf-heading">
      <div class="shell">
        <div class="panel fade-up">
          <div class="eyebrow">404</div>
          <h1 id="nf-heading" class="hero-title">Page not found</h1>
          <p class="hero-subtitle">That post may have moved or never existed.</p>
          <div class="cta-row">
            <a href="/" class="button button-primary">Back to the blog</a>
            <a href="${SITE.mainSite}" class="button button-secondary">Main site</a>
          </div>
        </div>
      </div>
    </section>`;
  return shell({
    title: `Page not found — ${SITE.title}`,
    description: "Page not found.",
    canonical: `${SITE.url}/404`,
    bodyClass: "blog-page",
    body,
  });
}
