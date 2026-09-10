# Sourav Mishra — Blog

A tiny, dependency-light static site generator for the blog at
`blog.souravmishra.net`. You write **Markdown or LaTeX**; a ~150-line Node build
emits static HTML with **build-time KaTeX math** (no client-side math JS),
syntax-highlighted code, clickable tag pages, an RSS feed, and a sitemap.
Visually it mirrors the main site [souravmishra.net](https://souravmishra.net)
but is a fully standalone repo and Vercel project.

- **Input:** `content/posts/*.md` and `content/posts/*.tex`
- **Output:** static `dist/` (pretty URLs, no runtime framework)
- **Publish:** commit + push → Vercel rebuilds automatically

See [INSTALL.md](INSTALL.md) for first-time setup, deployment, and troubleshooting.

---

## Write a post

1. Drop a file in `content/posts/`, named `YYYY-MM-DD-some-slug.md` (or `.tex`).
   The date prefix is stripped to form the URL slug `/some-slug/`. (Override the
   slug with `slug:` in frontmatter if you want.)
2. Add frontmatter (a `---` YAML block at the very top — required for **both**
   `.md` and `.tex`):

   ```yaml
   ---
   title: "Post title"              # required
   date: 2026-06-25                 # required — ISO date; drives ordering, display, feed
   description: "1–2 line summary"  # optional — <meta>, social cards, RSS; auto-derived if omitted
   tags: [machine-learning, vision] # optional — become clickable tag pages
   draft: false                     # optional — true => excluded from the build
   math: true                       # optional — auto-enabled when math is detected
   slug: custom-slug                # optional — override the filename-derived slug
   ---
   ```

3. Write the body below the frontmatter (Markdown or LaTeX — see below).
4. Commit and push. Vercel rebuilds and publishes automatically.

That's the whole loop — **no code changes per post.** Only `title` and `date`
are mandatory; missing either aborts the build with a clear error. `draft: true`
posts are skipped (and logged) so you can stage work-in-progress.

### Markdown body

Standard Markdown via `markdown-it` (`html: true`, linkify, typographer):

- Math: `$inline$` and `$$display$$`, pre-rendered to HTML at build time by KaTeX.
- Fenced code blocks (```` ```python ````) are highlighted at build time
  (highlight.js).
- Headings (`##`–`####`) get stable anchor ids with a clickable `#` permalink.
- External `http(s)` links automatically get `target="_blank"` + `rel="noopener"`.
- Raw HTML passes straight through (see *Interactive JS* below).

### LaTeX body (`.tex`)

Drop a `.tex` file instead of `.md` (same `YYYY-MM-DD-slug.tex` naming, same
`---` YAML block at the top, then plain LaTeX):

```latex
---
title: "A LaTeX-sourced note"
date: 2026-06-26
tags: [latex]
---

\section{Heading}
Body text with inline math $E = mc^2$ and display math:
\[ \int_0^1 x\,dx = \tfrac12 \]

\begin{itemize}
  \item A list item.
\end{itemize}
```

`.tex` is converted in-process by [lib/latex.mjs](lib/latex.mjs) using the
pure-JS `unified-latex` pipeline (**no `pandoc`, no external binary**); math is
rendered with the same build-time KaTeX engine as Markdown. Everything
downstream — slug, tags, description, reading time, RSS, sitemap, the index
table — is identical to a Markdown post.

> **LaTeX caveats.** `\section` maps to `<h3>` (a `unified-latex` default), and
> `\caption{}` inside a `figure` becomes a generic span rather than a styled
> `<figcaption>`. Content renders correctly; these are cosmetic. Use the
> document body only — no preamble/`\documentclass` is needed or processed.

### Tags

Tags in frontmatter render as clickable chips. Each distinct tag gets its own
page at `/tags/<slug>/` listing every post with that tag, newest-first
(generated automatically and added to the sitemap). Chips appear on the index,
post pages, and tag pages.

### Images & media

Put images in the single global folder **`assets/images/`** — no per-post
subfolders needed. Reference them by the same absolute `/images/<file>` path from
either format:

- Markdown: `![alt text](/images/diagram.png)`
- LaTeX: `\includegraphics{/images/diagram.png}` (include the extension —
  `\includegraphics{plot}` emits `src="plot"` and won't load)

Subfolders are allowed and preserved (`assets/images/2026/foo.png` →
`/images/2026/foo.png`). Images are styled automatically by `.prose img`
(centered, rounded, responsive) — no per-post CSS.

### Interactive JS / distill components

Per-post asset hooks (all optional frontmatter):

```yaml
styles:  ["/assets/posts/<slug>/fig.css"]   # <link> in <head>
scripts: ["/assets/posts/<slug>/fig.js"]    # <script type="module" defer> at body end
head:    "<raw head html>"                   # injected verbatim into <head> (escape hatch)
distill: true                                # load distill <d-*> web components
```

`markdown-it` allows raw HTML, so `<div>`, `<canvas>`, `<svg>`, and custom
elements in the post body pass straight through. For per-post libraries, drop
files under `assets/posts/<slug>/…` — the tree is copied to
`dist/assets/posts/…` and served at `/assets/posts/<slug>/…`. Scripts load with
`type="module" defer` after the site's own `/assets/blog.js`.

With `distill: true`, the **self-hosted** `template.v2.js` (vendored at
`assets/vendor/`) is loaded so `<d-math>`, `<d-figure>`, `<d-footnote>`, etc.
work in the body. Standalone components drop in cleanly; page-layout `<d-*>`
components (byline, citation auto-numbering) are experimental.

---

## Local development

```bash
npm install        # one-time — installs build deps + KaTeX (CSS/fonts source)
npm run build      # generates ./dist
npm run dev        # build + serve dist at http://localhost:4321
npm run clean      # remove ./dist
```

Requires **Node ≥ 18**. `dist/` is gitignored — it is regenerated on every build
and on every Vercel deploy.

---

## How it works

| Path                          | Responsibility                                                       |
| ----------------------------- | ------------------------------------------------------------------- |
| `build.mjs`                   | Reads posts, renders, writes `dist/` (pages, tags, feed, sitemap)   |
| `lib/markdown.mjs`            | `markdown-it` config: KaTeX math, highlight.js, anchors, link rules |
| `lib/latex.mjs`               | `.tex` → HTML via `unified-latex` + KaTeX (pure JS, no pandoc)      |
| `lib/templates.mjs`           | HTML shell, header/footer chrome, per-post SEO (OG, JSON-LD), `SITE`|
| `lib/feed.mjs`                | RSS, sitemap (incl. tag URLs), robots.txt builders                  |
| `assets/styles/blog.css`      | Design system + copied `katex.min.css` and fonts                    |
| `assets/blog.js`              | Small runtime: mobile nav, clickable list rows, scroll reveal       |
| `assets/images/`              | Global media → served at `/images/…`                                |
| `assets/posts/<slug>/`        | Optional per-post JS/CSS embeds → `/assets/posts/<slug>/…`          |
| `assets/vendor/`              | Self-hosted third-party libs (distill `template.v2.js`)             |
| `content/posts/`              | Your `.md` / `.tex` source — the only thing you touch to publish    |

The build is a single pass: parse frontmatter (`gray-matter`), render the body,
detect math to gate the KaTeX stylesheet per page, sort newest-first, then emit:

```
dist/
  index.html              # the post listing (Notion-style table)
  <slug>/index.html       # one per post (pretty URLs)
  tags/<slug>/index.html  # one per distinct tag
  feed.xml  sitemap.xml  robots.txt  404.html
  styles/   (blog.css, katex.min.css, fonts/)
  images/   assets/posts/   assets/vendor/   blog.js   favicon.svg
```

---

## Deploy (Vercel)

One repo ↔ one Vercel project:

- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- **Install Command:** `npm install`

Push to the repo → Vercel rebuilds and deploys. `vercel.json` supplies clean URLs,
trailing slashes, and immutable caching for fonts and KaTeX CSS. Assign the
domain `blog.souravmishra.net` when ready (DNS `CNAME` → Vercel). If the origin
changes, update `SITE.url` in [lib/templates.mjs](lib/templates.mjs) — it drives
canonical URLs, Open Graph tags, the feed, and the sitemap.

Full step-by-step setup, DNS, and troubleshooting live in [INSTALL.md](INSTALL.md).

---

## Design parity

This repo intentionally **duplicates** the main site's look so it can live on a
separate origin. If `souravmishra.net`'s design changes, mirror it here:

- `:root` design tokens and the header/footer/`.nav-bar` chrome live at the top
  of `assets/styles/blog.css` — copied from the main site's `styles/site.css`.
- The SVG icon sprite + nav markup live in `lib/templates.mjs` — copied from the
  main site's `index.html`.

Keeping these in sync is a manual, occasional task; the tokens rarely change.
