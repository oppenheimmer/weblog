# Sourav Mishra — Blog

A dependency-light engine for the blog at `blog.souravmishra.net`. Posts are
written in the browser, stored in Cloudflare R2, and built into static HTML
with **build-time KaTeX math** (no client-side math JavaScript), highlighted
code, tag pages, a full-article feed with a table view, RSS, and a sitemap.
Visually it mirrors the main site [souravmishra.net](https://souravmishra.net),
but it is a standalone repository and Vercel project.

- **Input:** published posts in Cloudflare R2; the repository holds none
- **Output:** static `dist/` with pretty URLs and no runtime framework
- **Publish:** write at `/editor/` → Publish → R2 → deploy hook → live

> **Engine in git, data in R2.** This repository contains no posts and no
> media, so cloning it gives you the framework and nothing to read. The build
> reads posts from R2. A build with no R2 credentials produces an empty site
> rather than failing, which is what a cloned engine should do.

See [INSTALL.md](INSTALL.md) for first-time setup, deployment, and
troubleshooting.

---

## Write a post

Sign in at **`/login/`** and write at **`/editor/`**. Fill in the fields, write
the body, then Publish. Changes autosave after a short quiet period; **Save** is
still available for an immediate checkpoint. Publishing freezes the saved revision into R2 and
triggers a rebuild; the post appears at `/<slug>/` a minute or so later. There
is no repository step and no terminal step.

Pasting a complete document beginning with `---` imports its title, date, slug,
description, tags, format and body. **Import source** does the same for `.md`,
`.markdown` and `.tex` files (and infers LaTeX from `.tex`). Browser-authored
documents cannot import engine-only script, style, head or Distill hooks.

| Field       | Required | Notes                                                    |
| ----------- | -------- | -------------------------------------------------------- |
| Title       | Yes      |                                                          |
| Date        | Yes      | Drives ordering, display, and the feed                   |
| Format      | Yes      | Markdown or LaTeX                                        |
| Slug        | No       | Derived from the title when empty; some routes reserved  |
| Description | No       | Meta tags, social cards, RSS; derived when empty         |
| Tags        | No       | Comma-separated; each tag gets its own page              |

Publishing refuses a post without a title, a date, or a body. Drafts live in
R2 and are never built.

**Preview** shows the post beside its source exactly as it will publish, in a
sandboxed frame. It reports what publishing would refuse as errors, and what
would not render as written, such as a broken formula or an unsupported LaTeX
command, as warnings. Warnings never block publishing.

**On the site** shows what readers actually see of a published post. It is read
back from the build manifest the site is serving, never assumed from a publish
having succeeded:

| State        | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| Live         | The site shows the revision last published               |
| Not live yet | Published in R2; the rebuild has not landed              |
| Updating     | The site still shows an earlier revision                 |
| Coming down  | Unpublished; the site shows it until the rebuild lands   |
| Unpublished  | Off the site; its revisions are kept for 90 days         |
| Not checked  | The site could not be read, and the panel says why       |

After each change the editor keeps checking. **A build that fails says why**:
the build records the reason in R2 — a post whose image is missing, content it
refuses to render — and the panel shows it with a link to the deployment log,
rather than leaving you watching a status that will never change. A build that
succeeds clears the record. If nothing lands within 15 minutes and no failure
was recorded, the build probably died before it started, and the panel says
that instead. From the same panel:

- **Unpublish** takes a post off the site. Its revisions stay, so it can come back.
- **Roll back** puts a stored revision back on the site; for an unpublished post
  the same button reads **Put back**. After a reload it still defaults to the
  revision last shown, even when a newer stored revision exists.
- **Edit as draft** branches the selected stored revision when a migrated or
  otherwise publication-only post has no draft. Its post identity and retained
  public media stay with it.
- **Rebuild site** rebuilds without changing any post, and sweeps what nothing
  needs any more — superseded revisions past the rollback window, abandoned
  uploads, orphaned media — reporting what it removed. It sits beside the list
  rather than in the panel, because it is about the site, not about a post.

A published post keeps its slug: publishing it under another is refused until
it is unpublished. Discarding a draft is refused while its post is published,
because the draft and the published copy live under the same post id. Every
post on the site is listed, including one with no draft.

### Markdown body

Markdown via `markdown-it`, with linkify and typographic quotes:

- Math: `$inline$` and `$$display$$`, pre-rendered to HTML by KaTeX at build
  time.
- Fenced code blocks (```` ```python ````) are highlighted at build time with
  highlight.js.
- Headings (`##`–`####`) get stable anchor ids and a `#` permalink.
- External `http(s)` links open in a new tab with `rel="noopener noreferrer"`.
- **Raw HTML is shown as text, never rendered**, so a post cannot carry markup
  or script. Links accept only `http`, `https`, `mailto`, and relative URLs.
- Images must be attachments (see below). An image pointing at another site
  renders as its alt text, so a post cannot make readers' browsers call a
  third party.

### LaTeX body

Choose **LaTeX** as the format and write the document body. No preamble or
`\documentclass` is needed or processed:

```latex
\section{Heading}
Body text with inline math $E = mc^2$ and display math:
\[ \int_0^1 x\,dx = \tfrac12 \]

\begin{itemize}
  \item A list item.
\end{itemize}
```

LaTeX is converted in-process by [lib/latex.mjs](lib/latex.mjs) using the
pure-JavaScript `unified-latex` pipeline (**no `pandoc`, no external binary**),
and its math is rendered by the same build-time KaTeX as Markdown. Everything
downstream — slug, tags, description, reading time, RSS, sitemap, listings — is
identical to a Markdown post.

> **LaTeX caveats.** `\section` maps to `<h3>` (a `unified-latex` default), and
> `\caption{}` inside a `figure` becomes a generic span rather than a styled
> `<figcaption>`. Commands the renderer does not support, such as `\ref`,
> `\cite`, or a `tikzpicture`, appear as preview warnings. A `\href` to an
> unsafe URL renders as plain text.

### Tags

Tags render as clickable chips on listings and post pages. Each distinct tag
gets a page at `/tags/<slug>/` listing its posts newest-first, added to the
sitemap automatically.

### Images and `.tex` snippets

Attach files in the editor with the attach button, by pasting, or by dropping
them on the page. The editor inserts the reference for the post's format, on a
line of its own so an image never lands mid-sentence; the **Insert** button in
the attachment list still inserts exactly at the cursor. An image row has an
editable alt-text field used by Insert. If source names an attachment that is
gone, the relinker offers verified attachments of the same kind and leaves
reference-looking examples inside code alone:

| Attachment     | Markdown                    | LaTeX                                    |
| -------------- | --------------------------- | ---------------------------------------- |
| Image          | `![alt](attachment://<id>)` | `\includegraphics{attachments/<id>.png}` |
| `.tex` snippet | `::tex[<id>]`               | `\input{attachments/<id>.tex}`           |

Images may be PNG, JPEG, GIF, or WebP, up to 10 MiB each. Snippets are UTF-8
`.tex` files up to 256 KiB. A post holds at most 25 attachments and 50 MiB.
Files are identified by their bytes, never by their names, and go straight from
the browser to R2.

Publishing turns each reference into a real path. A published image lives at
`/images/uploads/<slug>/<name>` under a readable name, so pasting `image.png`
twice gives `image.png` and `image-2.png`. Published pages carry each image's
width and height, so the page does not jump as images load. Snippets render
inline as part of the article.

### Interactive posts

Interactive publishing has two explicit paths. The choice describes how closely the animation needs to work with
the article:

| Path | Markdown | Use it for | Where its code runs |
| --- | --- | --- | --- |
| **Article figure** | `::figure[<id>]` | A Distill-style figure tied to the prose, page layout, theme or scroll position | Directly in the post page |
| **Interactive lab** | `::demo[<id>]` | A self-contained simulation, playground or larger application | In a sandboxed iframe |

An article figure intentionally has the same page access as the blog's own JavaScript. That is what lets it react
to nearby text or scrolling. Only an interactive folder explicitly attached, verified and published by the owner
can receive this access; ordinary Markdown still cannot contain raw HTML, `<script>` elements or script
frontmatter. A figure's entry is a `.mjs` module exporting `mount(root, context)`, and the engine gives it a
unique element on its post page. Its code does not run in the feed or tag listings.

An interactive lab is an ordinary small web folder displayed inside a sealed frame. JavaScript, canvas, WebGL and
controls work inside it, but it cannot read the article, editor or login session. Both the iframe and the lab
page's response apply the sandbox, so opening the lab URL directly does not remove the protection. A small checked
message channel passes presentation values: theme, reduced-motion preference and height.

Everything remains on **`blog.souravmishra.net`**. There is no separate demo hostname. The `/demos/` path receives
special sandbox headers, while its immutable public asset files receive only the narrow read permission needed
for local module imports and data files. Editor and API responses never receive that permission. Outside scripts,
CDNs and data services are not part of either path. A bundle may declare a library the engine vendors — today
only `distill` — and never a URL.

Both paths publish an immutable folder with a required static HTML fallback. For example:

```text
double-pendulum/
├── index.html        the lab's entry (a figure's is a .mjs module)
├── fallback.html     what listings, printers and readers without JavaScript get
├── demo.js
├── demo.css
└── equations.json
```

R2 places that folder below generated post, interactive and revision ids for safe ownership. It does **not**
rename `demo.js` or break `./equations.json`. The build maps those private ids to a readable, revisioned public
path such as `/demos/<post-slug>/double-pendulum/<revision>/`; every relative filename remains unchanged. SVG,
extra HTML pages and files outside the folder are refused, and a fallback is checked against a small allowlist
rather than cleaned.

The ordinary editor preview remains script-free, and the editor cannot attach a bundle yet: a deliberate **Run
interactive preview** action and a bundle panel are still to come. Listings, printing, no-JavaScript browsers,
loading and failures show the required fallback instead.

Every generated public page carries a CSP. Article figures may import modules
and fetch data from this site, but third-party script and data connections are
refused. The two fixed inline head scripts are admitted by exact hashes; Google
Fonts is named only for styles and fonts. Bundles therefore have to be
self-contained rather than merely promise to be.

#### Pushing a post with its interactives

Interactive folders are content, not engine code. They live in R2, never in Git. Today they reach a post through
the **staging push**, a second front end to the same publication service the editor uses. Stage one post per
folder, naming each interactive by its folder:

```text
staging/double-pendulum/
├── post.md                 frontmatter and body; ::demo[lab] and ::figure[energy]
├── lab/                    index.html, fallback.html, …
└── energy/
    ├── interactive.json    optional: {"entry": "chart.mjs", "dependencies": ["distill"]}
    ├── chart.mjs
    └── fallback.html
```

```bash
node --env-file=.env scripts/push.mjs staging/double-pendulum          # what it would do
node --env-file=.env scripts/push.mjs staging/double-pendulum --apply  # push, publish, clear
```

A lab's entry defaults to `index.html`, a figure's to `main.mjs`, and either fallback to `fallback.html`. The push
saves the draft with interactive ids where the source named folders, uploads each folder on signed URLs, and
publishes. Only then does it read every file back from R2, compare it with the bytes on disk, and delete what
matches — each folder whole, the source last. The folder is empty after a successful push.

It refuses before writing anything when a file would be left behind, a path is a link, frontmatter sets anything
beyond title, date, slug, description, tags and format, or a folder breaks the bundle contract. A push that fails
deletes nothing; a file changed during the push keeps its folder and the source; running the push again resumes.
Pushing to an address that already has a post updates that post, reusing interactives by name, and refuses to
replace a draft with unpublished editor changes unless given `--replace-draft`.

### Feed and table

The home page and every tag page show posts two ways, switched with the
**Feed / Table** control:

- **Feed**, the default and what a reader without JavaScript sees: complete
  articles, newest first. Pages continue at `/page/2/` once one page's articles
  would exceed about 350 KB of HTML, a budget set by measuring real posts.
- **Table:** every post in the listing, one row each, with title, date, and
  tags.

The reader's choice is remembered in their browser, and `?view=feed` or
`?view=table` overrides it for one visit.

### Legacy embed hooks for local builds

Posts read from a local directory through `BLOG_POSTS_DIR` are treated as
repository-authored and trusted. They may contain raw HTML and set per-post
asset hooks:

```yaml
styles:  ["/assets/posts/<slug>/fig.css"]   # <link> in <head>
scripts: ["/assets/posts/<slug>/fig.js"]    # <script type="module" defer> at body end
head:    "<raw head html>"                   # injected verbatim into <head>
distill: true                                # load distill <d-*> web components
```

The build copies a `posts/` folder from the assets directory
(`BLOG_ASSETS_DIR`) to `/assets/posts/`, and `distill: true` loads the
self-hosted `assets/vendor/distill.template.v2.js`. The test fixtures exercise
every hook, with their assets in `test/fixtures/assets/posts/`.
Script and stylesheet hooks must use same-origin paths: the public CSP refuses
outside code. Inline script or style placed in `head` is refused as well; use
the dedicated, self-hosted hooks for executable or styled content.

Posts published from the editor can never set these hooks, and their raw HTML
is escaped. In listings, a post that uses a hook appears as its title and
description with a link rather than inline, because its code assumes it owns
the page. It runs on its own page, once. This compatibility path is not the
R2 interactive system above: Distill supplies article components and
layout, while the post's own linked JavaScript supplies its animation.

---

## Local development

```bash
npm install        # one time: build dependencies and KaTeX (CSS and fonts)
npm run build      # generate ./dist
npm run dev        # build, then serve dist at http://localhost:4321
npm run clean      # remove ./dist
npm test           # the full suite; needs no credentials
npm run test:bless # re-record golden output after an intended change
```

Requires **Node 24.x** (`.nvmrc`, `engines`); Vercel rejects anything newer.
`dist/` is gitignored and regenerated on every build and deploy.

To build a set of posts without R2, keep them in a directory outside the
repository and point the build at it:

```bash
BLOG_POSTS_DIR=/tmp/posts BLOG_DIST_DIR=/tmp/dist npm run build
```

Each file there is `.md` or `.tex` with a YAML block at the top:

```yaml
---
title: "Post title"           # required
date: 2026-06-25              # required
description: "1–2 line summary"
tags: [machine-learning, vision]
slug: custom-slug             # otherwise derived from the filename
draft: true                   # excluded from the build
---
```

Checks that drive a real browser need Chromium; set `CHROMIUM` if the binary is
not `chromium-browser`:

```bash
node scripts/verify-listing.mjs          # feed and table: keyboard, phones, no JS
node scripts/verify-preview-sandbox.mjs  # the preview frame cannot run script
node scripts/verify-editor.mjs           # writing flow and On the site panel, against a stand-in site
node scripts/verify-editor-access.mjs    # file drop, clipboard paste, sign-out, keyboard and screen reader
```

`.github/workflows/ci.yml` runs the suite and a credential-free build on every
push and pull request, and every browser check on `main`; `audit.yml`
checks production advisories weekly. Neither is given a secret.

Scripts that touch the live R2 bucket need credentials and are run by hand.
Each works under a throwaway prefix and cleans up after itself:

```bash
node --env-file=.env scripts/probe-r2.mjs        # R2 capability probe
node --env-file=.env scripts/verify-store.mjs    # storage layer against real R2
node --env-file=.env scripts/verify-publish.mjs  # publish, unpublish, roll back, build
node --env-file=.env scripts/verify-uploads.mjs  # presigned uploads and CORS
node --env-file=.env scripts/verify-restore.mjs # back up, lose everything, restore, rebuild
```

---

## How it works

| Path                  | Responsibility                                                   |
| --------------------- | ---------------------------------------------------------------- |
| `build.mjs`           | Reads posts, fetches media, writes `dist/`                       |
| `lib/content.mjs`     | Source text → validated, rendered post; no filesystem access     |
| `lib/markdown.mjs`    | `markdown-it` setup: KaTeX, highlight.js, anchors, link rules    |
| `lib/latex.mjs`       | LaTeX → HTML via `unified-latex` and KaTeX, in pure JavaScript   |
| `lib/sanitize.mjs`    | Trust by provenance, the URL policy, the HTML tree filter        |
| `lib/attachments.mjs` | Resolves attachment references when a post is published          |
| `lib/media.mjs`       | Identifies images and snippets from their bytes                  |
| `lib/diagnostics.mjs` | Finds what the renderers dropped, for preview warnings           |
| `lib/listing.mjs`     | Listing model: feed pages split by rendered weight               |
| `lib/markup.mjs`      | Attribute edits that let posts share a page: ids, image sizes    |
| `lib/templates.mjs`   | Page shell, header and footer, listings, per-post SEO, `SITE`    |
| `lib/feed.mjs`        | RSS, sitemap, and `robots.txt`                                   |
| `lib/server/`         | R2 store, object keys, drafts, uploads, publish, preview, auth   |
| `api/`                | Vercel functions: login, editor, drafts, uploads, preview, publish |
| `assets/`             | Site and editor styles and scripts, vendored distill             |
| `test/`               | Golden output, contract invariants, tripwires, unit tests        |
| `scripts/`            | Browser checks, live R2 checks, password setup, inventory        |

The build reads published posts from R2, or from `BLOG_POSTS_DIR`, fetches and
verifies their images, renders each post, links the KaTeX stylesheet only on
pages that need it, sorts newest-first, and emits:

```text
dist/
  index.html              # the listing: full articles, with a table view
  page/<n>/index.html     # further feed pages, split by rendered weight
  <slug>/index.html       # one per post
  tags/<slug>/index.html  # one per tag, paginated the same way
  images/uploads/<slug>/  # published images
  feed.xml  sitemap.xml  robots.txt  404.html  favicon.svg
  build-manifest.json     # which post revisions this build contains
  styles/                 # blog.css, editor.css, katex.min.css, fonts/
  assets/                 # blog.js, editor.js, login.js, vendor/
```

When interactive publishing lands, the same build will also verify interactive manifests and emit immutable
figure assets below `/assets/figures/<post-slug>/…` and sealed lab folders below
`/demos/<post-slug>/…`. No runtime server will read R2 for a public post.

---

## Deploy (Vercel)

One repository, one Vercel project (`weblog`): the static `dist/` plus the
functions in `api/`, which serve `/login/`, `/editor/`, and `/api/*`. The build
command, output directory, clean URLs, trailing slashes, rewrites, and cache
headers are declared in `vercel.json`, so a new project needs no dashboard
configuration. Node is pinned to 24.x.

Pushing to `main` rebuilds the engine with the same content; publishing a post
fires the deploy hook and rebuilds with the same engine. Fonts and KaTeX CSS
are cached as immutable. Published images are revalidated instead, because a
readable URL is not a content hash.

The site is served at `blog.souravmishra.net`. If the origin changes, update
three things: `SITE.url` in [lib/templates.mjs](lib/templates.mjs), which drives
canonical URLs, Open Graph tags, the feed, and the sitemap; `SITE_URL` in the
project's environment, which sets the origin the editor accepts requests from
(it otherwise defaults to `https://blog.souravmishra.net` in production); and
the allowed origin in the R2 bucket's CORS rule.

Environment variables live in the Vercel project settings and, locally, in a
gitignored `.env`. Nothing env-shaped is committed. Full setup, DNS, and
troubleshooting are in [INSTALL.md](INSTALL.md).

---

## Design notes

Decisions and findings worth keeping, in roughly the order the engine was
built.

### Test harness and regression net

Built *before* touching the renderer, so every later change could be verified
rather than hoped at.

- **Golden output.** A fixture corpus under `test/fixtures/`, a manifest
  hashing every emitted file, and a handful of full pages kept as text. A
  failing hash names the page that moved; the stored pages show how.
  `npm run test:bless` re-records deliberately, and a diff under `test/golden/`
  means public output changed.
- **Contract invariants.** Post and tag URLs, canonicals matching emitted
  paths, feed and sitemap completeness, KaTeX gating, draft exclusion, and both
  listing views showing the same posts in the same order.
- **Determinism.** Two builds of the same input must produce identical output.

`build.mjs` takes `BLOG_POSTS_DIR`, `BLOG_ASSETS_DIR`, `BLOG_DIST_DIR`, and
`BLOG_FEED_PAGE_BYTES` overrides, so tests build fixtures without touching real
content. Adding them was verified byte-identical against the previous output
before anything else moved.

### Live defects fixed

Each one has a named tripwire test that fails if it comes back:

| Defect | Fix |
| --- | --- |
| JSON-LD broke out of its `<script>` on any title containing `</script>` — the payload truncated mid-string | `jsonLdScript()` escapes `<`, `>`, `&`, U+2028/9 |
| Two posts whose filenames reduced to the same slug silently overwrote each other in `dist/` | Duplicate slugs abort the build, naming both sources |
| Post order for equal dates depended on `readdir` order | Deterministic tie-break on slug |
| Dates rendered a day early anywhere west of UTC | `formatDate` pinned to UTC |
| `prefers-reduced-motion` disabled the animation that revealed content — those visitors got a blank page, as did anyone with JS off | Content visible by default; hidden only under `no-preference` **and** a `.js` root class |
| The scroll reveal needed a tenth of an element on screen, which a post body taller than ten screens never is — long posts stayed blank | Reveal as soon as any part is visible |

The timezone bug is the argument for the whole harness: this machine is UTC+9,
so golden output never showed it. Only the multi-timezone tripwire caught it.

### Content pipeline

`lib/content.mjs` turns source text into a validated, rendered post **with no
filesystem access**. That decoupling is the point: the build, the preview, and
publishing all go through one pipeline, rather than three that drift.
`build.mjs` is the only module that touches files.

Validation covers reserved slugs (a post cannot shadow `/tags/`, `/api/`,
`/editor/`, `/page/` or other generated routes), unparseable dates, empty
slugs, and unknown formats, all reported as author-facing `ContentError`s
rather than stack traces.

### R2 storage layer

`scripts/probe-r2.mjs` ran first, as a hard gate: "S3-compatible" does not
guarantee that any given S3 feature works, and the whole draft, session and job
design rests on conditional writes. **16/16 passed** against `weblog-data`.
`If-None-Match: *` and `If-Match` were both honoured, both rejecting with 412
rather than silently overwriting. Five concurrent racers on one key produced
exactly one winner. Read-after-write was consistent; pagination, server-side
copy, and presigned PUT and GET all worked; the bucket was confirmed private.

On that basis `lib/server/r2.mjs` provides prefix-scoped objects, JSON records
with `createJson`, `updateJson`, and `mutateJson`, paginated listing, presigned
URLs, and bounded retries.

Two notes worth keeping:

- **Retries exclude 412 on purpose.** A precondition failure is a real answer,
  not a blip; retrying it would defeat the concurrency control it implements. A
  test asserts the conflicting write is attempted exactly once.
- **Test it two ways.** Unit tests run against an in-memory double, so
  `npm test` needs no credentials, but a double is only trustworthy while it
  matches reality. `scripts/verify-store.mjs` runs the same module against the
  live bucket, and it caught `list("")` throwing on real R2 while the double was
  green. Run it whenever the storage layer or the double changes.

### Drafts with immutable revisions

`lib/server/drafts.mjs`. Every save writes a **new** revision object and then
moves a single pointer to it, conditionally. Nothing is ever overwritten, so
revision history is a side effect rather than a feature to build.

The ordering matters: revision first, pointer second. If the pointer update
loses a race, the new revision is orphaned — harmless and collectable — while
the previous draft stays intact. Losing the race must never lose work. There
are tests for this against both the double and the real bucket.

Drafts validate *loosely on absence, strictly on shape*: a half-written post
with no title must still save, but a 10 MB title or a malformed date is refused.
That caught a real bug — `2026-02-30` passes an ISO regex, and `Date` silently
rolls it over to March 2. Validation now round-trips the parsed date and
compares.

Revision ids sort chronologically as plain strings, so history needs a listing
rather than a read of every object. They lead with the version number rather
than a timestamp: two saves in the same millisecond would otherwise have sorted
by their random suffix.

### Authentication

`lib/server/passwords.mjs`, `lib/server/sessions.mjs`, and
`lib/server/rate-limit.mjs`.

- **Password.** scrypt via `node:crypto`, with its parameters stored inside the
  hash string, so cost can be raised later without invalidating the existing
  password. Benchmarked at 63 ms for N=2^15 and 261 ms for N=2^17 (~128 MB).
  Settled on 2^17: login happens about once per idle window, so a quarter
  second is imperceptible, and it is four times the work for anyone cracking a
  stolen hash offline. Set one with `node scripts/set-password.mjs`, which
  prompts with echo off and refuses to read from a pipe.
- **Sessions.** Random tokens, with only their SHA-256 stored, so read access to
  the bucket hands over nothing usable. The idle timeout is 8 hours, refreshed
  on activity, with a hard 7-day ceiling. Expiry is enforced on every read, not
  by a sweep, so a record that outlives its deadline never authenticates even
  if cleanup has not run. Rotating `AUTH_VERSION` revokes every session at once.
- **CSRF.** Derived from the session's own secret by HMAC rather than stored, so
  there is no second record to keep in sync, and a token lifted from one session
  cannot be replayed against another.
- **Rate limiting.** Durable in R2, because serverless instances share no memory
  and an in-memory counter resets on every cold start. Each attempt is counted
  by a conditional write *before* the password is checked, so a burst of
  simultaneous requests cannot all slip under the limit. An address gets five
  attempts per 15 minutes, and anonymous attempts share a budget that bounds
  how much password work they can cause. A browser that has signed in before
  carries a signed device cookie and gets a budget of its own, so failures from
  anywhere else cannot lock the owner out of it. A correct password gives its
  attempt back. Client addresses come only from platform-set forwarding
  metadata; a browser-settable `X-Forwarded-For` would let an attacker pick a
  new identity per attempt. An attempt that cannot be counted is refused.

Lockout recovery is the 15-minute window expiring on its own; a browser that
has signed in before is not affected by other people's failures at all. In an
emergency, changing `ADMIN_PASSWORD_HASH` sets a new password *and* ends every
session. There is no bypass secret: it would be a second credential of equal
power that never gets rotated. The device cookie is not one — it buys a
separate attempt counter, never a way around the password.

### Editor API

Routes under `api/`: login, logout and session; draft listing, creation,
reading, saving and discarding; uploads; preview; publish. The guards live in
`lib/server/http.mjs`, not in each handler, so adding a route cannot
accidentally omit one: a route opts *out* explicitly and never has to remember
to opt in.

- Login is rate limited *before* the password is read, so a locked-out caller
  cannot keep paying for scrypt work. A wrong password, an absent password, and
  an unconfigured server are indistinguishable in the response.
- Origins are matched exactly. A suffix test is how this check usually gets
  defeated; there is a test for `blog.souravmishra.net.attacker.com`.
- A missing `Origin` on a mutation is refused, not allowed. Browsers always send
  it there, so its absence means something that is not a browser.
- A stale save returns **409 carrying the current draft and its ETag**, so the
  editor can show what changed rather than reporting that work vanished. Saving
  with no ETag is 428, never a silent clobber.
- Everything that changes what the site shows goes through `/api/publish/`:
  publish, unpublish, roll back, rebuild. One function, since every function
  counts against Vercel's per-deployment limit. Each change is one conditional
  update of the published index, then the deploy hook. An index write that loses
  a race is re-read and decided again, so a concurrent change is neither reported
  as a failure nor undone.
- Publishing is idempotent only while the index still names the revision. A
  publish interrupted before its commit point resumes once a ten-minute lease has
  passed; one whose hook failed fires only the hook; one rolled back or
  unpublished since is published again rather than answered with its old job.
- Live status is read from `/build-manifest.json` on the public site, fetched
  with `no-store` and a random query parameter, and matched on post id, revision
  and slug. No Vercel token is needed. A site that cannot be read is reported as
  not checked, never as a site with nothing on it.
- A failed build publishes no manifest, so waiting cannot distinguish one from a
  slow build. The build writes its own reason to a single key, which the next
  successful build deletes — so the record can never accumulate, and its presence
  always means the most recent build failed. Vercel's dashboard knows too, but
  the reason lives in build logs the Hobby plan keeps for an hour.
- Calling the deploy hook again while a build of the same commit is running
  cancels the earlier build, which is what collapses a burst of publishes into
  one deployment.

*Deployment findings worth keeping:*

- `trailingSlash` in `vercel.json` applies to API routes too, so `/api/x`
  308-redirects to `/api/x/`. POST survives with its method intact, but the
  editor calls API paths **with** the trailing slash to skip the round trip.
  Dynamic routes must be nested as `[id]/index.js`, or they never match. Removing
  `trailingSlash` is not an option: public post URLs and their canonical tags
  depend on it.
- Vercel serves `api/` functions alongside a static `outputDirectory`, imports
  from `lib/` outside `api/` resolve once bundled, and the functions reach R2
  with production credentials. Confirmed by a throwaway probe rather than
  assumed.
- Production uses `R2_PREFIX=prod`; local development defaults to `dev`, so
  local work cannot touch published data.

### Editor and login pages

`/login/` and `/editor/` are served by functions, never emitted into `dist/`:
anything in `dist/` is public, and the editor markup must not be. An
unauthenticated `/editor/` redirects to `/login/` rather than returning a JSON
401, since it is a browser navigation; `/login/` redirects back when a session
already exists.

Editor pages send a strict CSP with **no inline script**, plus `noindex`,
`nosniff`, and `no-store`. That is required rather than nice to have: the editor
shares an origin with the published site, so any script that reached a
published page would run where the editor session lives. The preview frame is
sandboxed with no permissions at all, so a script placed in a preview cannot
run either. Public pages have a separate policy that admits same-origin code and
data but refuses third-party script and connections. Article figures are the
narrow owner-authorized exception: they receive page access only through a
verified `::figure` record. `::demo` labs remain sandboxed even though their
files use the same hostname.

The client is dependency-free: metadata fields, a textarea, attachments, a live
preview, conditional saves, Ctrl/Cmd-S, and a `beforeunload` guard.

- "Unsaved" is a comparison against what was last persisted, not a flag that can
  drift out of sync with the fields.
- A 409 opens a dialog rather than resolving silently. Both versions are real
  work, and the wording says plainly which button discards what.
- A 401 mid-session does **not** clear the editor. It says the session ended
  and points at Export, which writes the current text to a local file and
  depends on neither the network nor the session.
- A 409 is an error unless the caller resolves conflicts itself, and only a
  draft save does. While every 409 came back as a success, a publish refused for
  its address reported itself as published.
- **On the site** checks again after every change: after 4 seconds, then less
  often, up to every 30 seconds. After 15 minutes it stops and says the build
  may have failed. Whatever is still on its way when the editor opens is watched
  again, so a reload loses nothing.

*Bug worth remembering:* accepting HEAD wherever GET is allowed, but passing it
through unchanged, meant `HEAD /api/drafts/` reached the create branch.
Handlers dispatch on `req.method` with the mutating path as the fall-through, so
a HEAD request would have created a draft. HEAD is now normalized to GET before
any handler runs, which makes that whole class of mistake impossible rather
than something each handler has to remember.

### Inventory and garbage collection

`inventory.json` in R2 is a tree of every post, its revisions, and its media,
plus orphaned media and pending uploads. `formatTree` prints it readably:

```bash
node --env-file=.env scripts/inventory.mjs               # print the tree
node --env-file=.env scripts/inventory.mjs --gc          # what would be swept
node --env-file=.env scripts/inventory.mjs --gc --apply  # sweep
```

The file is **derived, never maintained**: it is rebuilt from the published
index, the draft pointers, and the objects actually present, rather than patched
as things change. An incrementally updated index becomes a second source of
truth and eventually disagrees with reality, which is worst precisely when
deciding what to delete.

Collection is **ownership-scoped**, not reachability-scoped. Every object
carries its owning post's id in its key (`lib/server/keys.mjs`), so deletion is
always scoped to one post:

```text
drafts/<postId>/current.json
drafts/<postId>/revisions/<revisionId>.json
published/posts/<postId>/<revisionId>.json
published/media/<postId>/<name>        -> /images/uploads/<slug>/<name>
uploads/<postId>/<uploadId>/…
attachments/<postId>/…
```

Interactive bundles extend this ownership tree with
`interactives/<postId>/<interactiveId>/<revision>/…` and their published copies
under `published/interactives/`. Their readable public paths are produced at
publish time; the private keys never appear in a public page.

That bounds the blast radius. A global mark-and-sweep that misses one edge
deletes across every post; here a mistake can only damage the post already being
worked on, and other posts' objects are unreachable **by construction** rather
than by care. `deletePostObjects` re-checks every key it collected and refuses
outright if one is not owned by the post being deleted.

Keys use the post **id**, never the slug: slugs are human-chosen and reusable,
so a new post could otherwise inherit a deleted one's directory. Public URLs
stay slug-based and readable, and the build maps between them. Nothing is shared
between posts, so the same image in three posts is stored three times. That
forgoes deduplication so that deleting one post can never remove a file another
still uses.

Four further guards:

| Guard | Why |
| --- | --- |
| Current published revision, current draft and its pointer are never collectable | Losing one loses a post |
| Nothing younger than 1 hour is ever swept | A new object may belong to an upload or publish still in flight |
| Keys matching no known pattern are reported, never deleted | Far likelier that `lib/server/keys.mjs` is out of date than that the object is rubbish |
| Dry by default, bounded per run | The failure mode is losing work, not wasting bytes |

Retention: superseded published revisions 90 days (the rollback window), draft
history 30 days or 20 revisions per post, unattached uploads 24 hours. A post
unpublished without a draft is referenced by nothing, yet keeps every object
while any of its published revisions is inside the rollback window, so it can
still be put back.

It runs automatically after publish, unpublish, rollback, and draft discard, and never
throws: a publish that succeeded must not be reported as failed because
housekeeping afterwards did not. Every draft save writes an immutable revision,
so without a sweep, saving alone would grow the bucket forever.

---

## Design parity

This repository intentionally **duplicates** the main site's look so it can live
on a separate origin. If `souravmishra.net`'s design changes, mirror it here:

- `:root` design tokens and the header, footer, and `.nav-bar` chrome live at
  the top of `assets/styles/blog.css`, copied from the main site's
  `styles/site.css`.
- The SVG icon sprite and nav markup live in `lib/templates.mjs`, copied from the
  main site's `index.html`.

Keeping these in sync is a manual, occasional task; the tokens rarely change.
