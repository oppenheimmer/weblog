# Installing, building, and deploying the blog

This guide covers everything operational: local setup, the build pipeline,
publishing on **Vercel**, pointing a domain at it, and
troubleshooting. For the authoring contract (frontmatter, Markdown/LaTeX,
images, embeds) see [README.md](README.md).

---

## 0. Prerequisites

| Requirement | Notes                                                            |
| ----------- | ---------------------------------------------------------------- |
| **Node ≥ 18** | The build uses native `fs.cpSync` and ES modules. Check `node -v`. |
| **npm**     | Ships with Node; used for install + scripts.                     |
| **git**     | The repo is connected to a provider Vercel can import.           |

No global tools are required — everything (KaTeX, `markdown-it`, `unified-latex`)
is a local dependency installed by `npm install`. There is **no `pandoc`
dependency**; LaTeX is converted in pure JS.

---

## 1. Local setup & build

```bash
git clone <repo-url> website-blog
cd website-blog
npm install        # installs build deps + KaTeX (its CSS/fonts are copied at build)
npm run build      # generates ./dist
npm run dev        # build + serve dist at http://localhost:4321
npm run clean      # remove ./dist
```

What `npm run build` does (`build.mjs`, single pass):

1. Wipes and recreates `dist/`.
2. Reads every `.md` / `.tex` in `content/posts/`, parsing the `---` frontmatter
   with `gray-matter`. Drafts (`draft: true`) are skipped and logged; a post
   missing `title` or `date` aborts the build with a clear error.
3. Renders each body — Markdown via `markdown-it`, LaTeX via `lib/latex.mjs` —
   pre-rendering math with KaTeX so **no client-side math JS is needed**.
4. Sorts posts newest-first and writes:
   - `index.html` (the listing: full articles, with a table view of every post),
     continuing at `page/<n>/index.html` once the articles outweigh one page
   - `<slug>/index.html` per post
   - `tags/<slug>/index.html` per distinct tag (newest-first within each, paginated the same way)
   - `feed.xml`, `sitemap.xml` (posts **and** tag pages), `robots.txt`, `404.html`
5. Copies static assets into `dist/`:
   - `assets/styles/` → `styles/`
   - `assets/images/` → `images/` (global media)
   - `assets/posts/` → `assets/posts/` (per-post embeds)
   - `assets/vendor/` → `assets/vendor/` (e.g. distill `template.v2.js`)
   - `assets/blog.js`, `assets/favicon.svg`
   - KaTeX `katex.min.css` → `styles/`, fonts → `styles/fonts/`

`dist/` is gitignored; it is fully regenerated each build, locally and on Vercel.

---

## 2. Create the Vercel project

1. Go to <https://vercel.com/new>.
2. **Import** the `website-blog` git repository.
3. When prompted for **Framework Preset**, choose **Other** (this is a custom
   static generator, not a known framework).
4. Set the build settings exactly:

   | Setting              | Value             |
   | -------------------- | ----------------- |
   | **Build Command**    | `npm run build`   |
   | **Output Directory** | `dist`            |
   | **Install Command**  | `npm install`     |
   | **Root Directory**   | `./` (repo root)  |

5. Click **Deploy**. The first build runs `npm install` then `npm run build`,
   and Vercel serves the generated `dist/` directory.

`vercel.json` (already in the repo) supplies clean URLs, trailing slashes, and
long-lived **immutable** cache headers for fonts (`/styles/fonts/*`) and KaTeX
CSS (`/styles/katex.min.css`) — those filenames are stable, so caching them hard
is safe. No extra dashboard config is needed.

> **Images and `blog.js` are not content-hashed**, so they are served with
> Vercel's default caching (no `immutable` rule). If you replace an image under
> the same name, expect normal CDN cache behavior. To force a hard refresh, use
> a new filename or add a query string when referencing it.

---

## 3. Point domain at the project

1. In the Vercel project, open **Settings → Domains**.
2. Add the domain: `blog.souravmishra.net`.
3. Vercel will show the DNS record to create. Add it wherever DNS for
   `souravmishra.net` is managed:

   | Type    | Name   | Value                  |
   | ------- | ------ | ---------------------- |
   | `CNAME` | `blog` | `cname.vercel-dns.com` |

   (Use the exact target Vercel displays — it is occasionally different.)
4. Wait for DNS to propagate; Vercel auto-provisions HTTPS once it verifies the
   record. The status in **Settings → Domains** turns to **Valid**.

> **After the domain is live**, confirm `SITE.url` in `lib/templates.mjs` matches
> the final origin (currently `https://blog.souravmishra.net`). It drives
> canonical URLs, Open Graph tags, the RSS feed, and the sitemap. If you change
> it, commit and push to trigger a rebuild.

---

## 4. Verify the deployment

Once deployed, check:

- `https://blog.souravmishra.net/` — the listing shows full articles newest-first,
  styled like the main site (fonts, colors, nav, footer). **Table** switches to a
  compact table with clickable rows, and the choice survives a reload.
- Open a post — math, highlighted code, and heading anchors render. **Disable
  JavaScript and reload**: the math is still there (pre-rendered at build).
- Click a **tag chip** — `/tags/<slug>/` lists only posts with that tag,
  newest-first.
- A `.tex`-sourced post renders headings, lists, and KaTeX math like a Markdown
  post.
- `https://blog.souravmishra.net/feed.xml` and `/sitemap.xml` load as valid XML
  (the sitemap includes `/tags/<slug>/` URLs).

---

## 5. Day-to-day publishing

1. Add a `.md` or `.tex` file to `content/posts/` (see [README.md](README.md) for
   the frontmatter contract). Add any images to `assets/images/`.
2. Optionally `npm run dev` to preview at <http://localhost:4321> before pushing.
3. Commit and push.
4. Vercel rebuilds and deploys automatically — no dashboard steps, no code
   changes.

---

## 6. Troubleshooting

| Symptom                                              | Cause & fix                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Build error: `katex.min.css not found`               | Dependencies not installed in the build env. Run/ensure `npm install` runs before `npm run build`.   |
| A post doesn't appear                                | It has `draft: true` (intentional), or the build skipped it — check the build log.                   |
| Build aborts: *missing required frontmatter*         | The post lacks `title` or `date`. Both are mandatory for `.md` **and** `.tex`.                        |
| Math shows as raw `$…$` text                          | The expression failed to parse. KaTeX runs with `throwOnError: false`, so check the source delimiters. |
| LaTeX image doesn't load                             | `\includegraphics{name}` had no extension, or the path isn't `/images/<file>`. Use `/images/foo.png`. |
| `.tex` heading looks too small                       | `\section` maps to `<h3>` by design (`unified-latex`). Cosmetic; use as-is or adjust in `lib/latex.mjs`. |
| Styles look wrong after a main-site redesign         | Re-mirror tokens/chrome — see **Design parity** in [README.md](README.md).                            |
| Old image still served after replacing it            | Non-hashed assets follow CDN caching. Use a new filename or a cache-busting query string.             |

---

## Dependencies (reference)

Installed by `npm install`; pinned in `package.json`:

- `markdown-it` + `markdown-it-anchor` + `markdown-it-texmath` — Markdown + anchors + math delimiters
- `katex` — build-time math rendering (and the CSS/fonts copied into `dist/`)
- `highlight.js` — build-time code highlighting
- `gray-matter` — `---` YAML frontmatter parsing (works on `.md` and `.tex`)
- `unified` + `rehype-stringify` + `@unified-latex/unified-latex-util-parse` +
  `@unified-latex/unified-latex-to-hast` — pure-JS LaTeX → HTML pipeline

The only runtime asset shipped to browsers is the small `assets/blog.js`
(mobile nav, feed/table switch, clickable rows, scroll reveal) plus any per-post embeds you add —
there is no framework runtime.
