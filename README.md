# Sourav Mishra — Blog

A dependency-light static site generator for the blog at
`blog.souravmishra.net`. Markdown or LaTeX in, static HTML out, with
**build-time KaTeX math** (no client-side math JS), syntax-highlighted code,
clickable tag pages, an RSS feed, and a sitemap. Visually it mirrors the main
site [souravmishra.net](https://souravmishra.net) but is a standalone repo and
Vercel project.

- **Input:** published posts in Cloudflare R2 (the repo holds none)
- **Output:** static `dist/` (pretty URLs, no runtime framework)
- **Publish:** write in `/editor/` → Publish → R2 → deploy hook → live

> **Engine in git, data in R2.** This repository contains no posts and no
> media — cloning it gives you the framework and nothing to read. Posts are
> written in the browser at `/editor/` and live in Cloudflare R2; the build
> reads them from there. A build with no R2 credentials produces an empty site
> rather than failing, which is what a cloned engine should do.

See [INSTALL.md](INSTALL.md) for first-time setup, deployment, and troubleshooting.

---

## Write a post

Sign in at **`/login/`** and write at **`/editor/`**. Set a title, date, tags and
body, Save, then Publish. Publishing freezes the revision into R2 and triggers a
rebuild; the post appears at `/<slug>/` a minute or so later.

There is no repository step and no terminal step. `content/posts/` no longer
exists — the repo is the engine, R2 holds the data.

The frontmatter fields below describe what the editor stores per post and what a
`.tex` or `.md` body may contain; they are no longer written by hand.

<details>
<summary>Frontmatter reference</summary>

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

</details>

Only `title` and `date` are mandatory; publishing refuses without them, and
without a body. Drafts live in R2 and are never built.

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

```bash
npm test           # 56 tests, no credentials needed
npm run test:bless # re-record golden output after an intended change
```

Requires **Node 24.x** (`.nvmrc`, `engines`). Vercel rejects anything newer.
`dist/` is gitignored — regenerated on every build and every Vercel deploy.

Scripts that touch the live R2 bucket need credentials and are run by hand:

```bash
node --env-file=.env scripts/probe-r2.mjs     # R2 capability probe
node --env-file=.env scripts/verify-store.mjs # storage layer vs. real R2
```

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
| `lib/content.mjs`             | Source text → validated, rendered post. No filesystem access        |
| `lib/server/config.mjs`       | R2 settings, validated; never logs a credential value               |
| `lib/server/r2.mjs`           | R2 object store: JSON records, conditional writes, presigned URLs   |
| `test/`                       | Golden output, contract invariants, tripwires, storage semantics    |
| `scripts/`                    | Manual R2 probes (need credentials, not part of `npm test`)         |
| `lib/server/publish.mjs`      | Freeze a revision to R2, update the slug index, fire the deploy hook |
| `lib/server/published.mjs`    | Build-side reader: R2 revisions → rendered posts                    |

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

One repo ↔ one Vercel project (`weblog`), which will also serve `/editor` and
`/api/*` as functions.

Build command and output directory are declared in `vercel.json`, so a freshly
created project needs no dashboard configuration. Node is pinned to `24.x` in
`engines` and `.nvmrc`.

Push to the repo → Vercel rebuilds and deploys. `vercel.json` also supplies clean
URLs, trailing slashes, and immutable caching for fonts and KaTeX CSS. Assign the
domain `blog.souravmishra.net` when ready (DNS `CNAME` → Vercel). If the origin
changes, update `SITE.url` in [lib/templates.mjs](lib/templates.mjs) — it drives
canonical URLs, Open Graph tags, the feed, and the sitemap.

Environment variables live in Vercel project settings and, locally, in a
gitignored `.env`. Nothing env-shaped is committed.

Full step-by-step setup, DNS, and troubleshooting live in [INSTALL.md](INSTALL.md).

---

## Progress

Where the browser-authoring conversion has got to, and the decisions worth
remembering. Full plan and rationale live in `CLAUDE.md` (not committed).

### Done — test harness and regression net

Built *before* touching the renderer, so the refactor could be verified rather
than hoped at.

- **Golden output.** An 8-post fixture corpus under `test/fixtures/`, a manifest
  hashing every emitted file, and 7 full pages kept as text. A failing hash names
  the page that moved; the stored pages show how. `npm run test:bless` re-records
  deliberately — a diff under `test/golden/` means public output changed.
- **Contract invariants.** Post and tag URLs, canonical matching emitted path,
  feed and sitemap completeness, KaTeX gating, draft exclusion.
- **Determinism.** Two builds of the same input must produce identical output.

*Note:* `build.mjs` takes `BLOG_POSTS_DIR` / `BLOG_ASSETS_DIR` / `BLOG_DIST_DIR`
overrides so tests build fixtures without touching real content. Adding them was
verified byte-identical against the previous output before anything else moved.

### Done — five live defects fixed

Each found by reading the source, each with a named tripwire test written to fail
first. All were shipping:

| Defect | Fix |
| --- | --- |
| JSON-LD broke out of its `<script>` on any title containing `</script>` — the payload truncated mid-string | `jsonLdScript()` escapes `<`, `>`, `&`, U+2028/9 |
| Two posts whose filenames reduced to the same slug silently overwrote each other in `dist/` | Duplicate slugs abort the build, naming both sources |
| Post order for equal dates depended on `readdir` order | Deterministic tie-break on slug |
| Dates rendered a day early anywhere west of UTC | `formatDate` pinned to UTC |
| `prefers-reduced-motion` disabled the animation that revealed content — those visitors got a blank page, as did anyone with JS off | Content visible by default; hidden only under `no-preference` **and** a `.js` root class |

The timezone bug is the argument for the whole harness: this machine is
UTC+9, so golden output never showed it. Only the multi-timezone tripwire caught it.

### Done — content pipeline extracted

`lib/content.mjs` turns source text into a validated, rendered post **with no
filesystem access**. That decoupling is the point: the build feeds it files, and
the R2 reader and editor preview will feed it strings, through one pipeline
rather than three that drift. `build.mjs` dropped to ~118 lines and is now the
only module that touches files.

Added validation: reserved slugs (a post can no longer shadow `/tags/`, `/api/`,
`/editor/`, `/404/`), unparseable dates, empty slugs, unknown formats — all
reported as author-facing `ContentError`s rather than stack traces.

### Done — R2 storage layer

`scripts/probe-r2.mjs` ran first, as a hard gate: "S3-compatible" does not
guarantee any given S3 feature works, and the whole draft/session/job design
rests on conditional writes. **16/16 passed** against `weblog-data` —
`If-None-Match: *` and `If-Match` both honoured, both rejecting with 412 rather
than silently overwriting; five concurrent racers on one key produced exactly one
winner; read-after-write consistent; pagination, server-side copy and presigned
PUT/GET all work; bucket confirmed private.

On that basis `lib/server/r2.mjs` provides prefix-scoped objects, JSON records
with `createJson` / `updateJson` / `mutateJson`, paginated listing, presigned
URLs, and bounded retries.

Two notes worth keeping:

- **Retries exclude 412 on purpose.** A precondition failure is a real answer,
  not a blip; retrying it would defeat the concurrency control it implements.
  A test asserts the conflicting write is attempted exactly once.
- **Test it two ways.** Unit tests run against an in-memory double so `npm test`
  needs no credentials, but a double is only trustworthy while it matches
  reality. `scripts/verify-store.mjs` runs the same module against the live
  bucket, and it caught `list("")` throwing on real R2 while the double was
  green. Run it whenever the storage layer or the double changes.

### Done — drafts with immutable revisions

`lib/server/drafts.mjs`. Every save writes a **new** revision object and then
moves a single pointer to it, conditionally. Nothing is ever overwritten, so
revision history is a side effect rather than a feature to build.

The ordering matters: revision first, pointer second. If the pointer update
loses a race, the new revision is orphaned — harmless and collectable — while
the previous draft stays intact. Losing the race must never lose work. There are
tests for this against both the double and the real bucket.

Drafts validate *loosely on absence, strictly on shape*: a half-written post with
no title must still save, but a 10 MB title or a malformed date is refused. That
caught a real bug — `2026-02-30` passes an ISO regex, and `Date` silently rolls
it over to March 2. Validation now round-trips the parsed date and compares.

Revision ids are time-prefixed base36, so they sort chronologically as plain
strings and history needs a listing rather than a read of every object.

### Done — auth primitives

`passwords.mjs`, `sessions.mjs`, `rate-limit.mjs`. Not yet wired to routes.

- **Password.** scrypt via `node:crypto`, parameters stored inside the hash
  string so cost can be raised later without invalidating the existing password.
  Benchmarked on this machine: 63 ms at N=2^15, 261 ms at N=2^17 (~128 MB).
  Settled on 2^17 — login happens about once per idle window, so a quarter
  second is imperceptible and four times the work for anyone cracking a stolen
  hash offline. Set one with `node scripts/set-password.mjs`, which prompts with
  echo off and refuses to read from a pipe.
- **Sessions.** Random tokens, only their SHA-256 stored, so read access to the
  bucket hands over nothing usable. Idle timeout of 8 h refreshed on activity,
  hard 7-day ceiling. Expiry is enforced on every read, not by a sweep — a
  record that outlives its deadline never authenticates even if cleanup has not
  run. Rotating `AUTH_VERSION` revokes everything at once.
- **CSRF.** Derived from the session's own secret by HMAC rather than stored, so
  there is no second record to keep in sync and a token lifted from one session
  cannot be replayed against another.
- **Rate limiting.** Durable in R2, because serverless instances share no memory
  and an in-memory counter resets on every cold start. Per-client *and* global
  limits: the first stops guessing at one password, the second stops a spray
  where no single address trips it. Client addresses come only from
  platform-set forwarding metadata — a browser-settable `X-Forwarded-For` would
  let an attacker pick a new identity per attempt. Fails closed if the store is
  unreadable.

Lockout recovery is the 15-minute window expiring on its own; for an emergency,
changing `ADMIN_PASSWORD_HASH` sets a new password *and* kills every session. No
bypass secret — it would be a second credential of equal power that never gets
rotated.

*Bug worth remembering:* revision ids were originally timestamp-led, so two
saves in the same millisecond sorted by their random suffix. Debounced autosave
does exactly that. Ids are now version-led, which cannot tie.

### Done — editor API

Routes under `api/`: login, logout, session, list/create drafts,
get/save/delete a draft. Guards live in `lib/server/http.mjs`, not in each
handler, so adding a route cannot accidentally omit one — a route opts *out*
explicitly and never has to remember to opt in.

Verified against the live deployment: anonymous callers get 401 on every
private route, a cross-origin login gets 403, and a wrong password gets 401
with no cookie set.

- Login is rate limited *before* the password is read, so a locked-out caller
  cannot keep paying for scrypt work. Wrong password, absent password and an
  unconfigured server are indistinguishable in the response.
- Origins are matched exactly. A suffix test is how this check usually gets
  defeated; there is a test for `blog.souravmishra.net.attacker.com`.
- A missing `Origin` on a mutation is refused, not allowed — browsers always
  send it there, so its absence means something that is not a browser.
- A stale save returns **409 carrying the current draft and its ETag**, so the
  editor can show a real diff rather than reporting that work vanished.
  Saving with no ETag is 428, never a silent clobber.

*Deployment findings worth keeping:*

- `trailingSlash` in `vercel.json` applies to API routes too, so `/api/x`
  308-redirects to `/api/x/`. POST survives it with the method intact, but the
  editor calls API paths **with** the trailing slash to skip the round trip.
  Removing `trailingSlash` is not an option — the public post URLs and their
  canonical tags depend on it.
- Vercel serves `api/` functions alongside a static `outputDirectory`, imports
  from `lib/` outside `api/` resolve once bundled, and the function reaches R2
  with production credentials. Confirmed by a throwaway probe rather than
  assumed.
- Production uses `R2_PREFIX=prod`; local development defaults to `dev`, so
  local work cannot touch published data.

### Done — editor and login pages

`/login/` and `/editor/` are served by functions, never emitted into `dist/` —
anything in `dist/` is public and the editor markup must not be. An
unauthenticated `/editor/` redirects to `/login/` rather than returning a JSON
401, since it is a browser navigation; `/login/` redirects back when a session
already exists.

Editor pages send a strict CSP with **no inline script**, plus `noindex`,
`nosniff` and `no-store`. §3.1 of the plan records why that is required rather
than nice to have: the editor shares an origin with published posts that can
carry custom JavaScript.

The client is dependency-free — metadata fields, a textarea, conditional saves,
Ctrl/Cmd-S, and a `beforeunload` guard.

- "Unsaved" is a comparison against what was last persisted, not a flag that can
  drift out of sync with the fields.
- A 409 opens a dialog rather than resolving silently. Both versions are real
  work, and the wording says plainly which button discards what.
- A 401 mid-session does **not** clear the editor. It says the session ended and
  points at Export, which writes the current text to a local file and depends on
  neither the network nor the session.

*Bug worth remembering:* accepting HEAD wherever GET is allowed, but passing it
through unchanged, meant `HEAD /api/drafts/` reached the create branch —
handlers dispatch on `req.method` with the mutating path as the fall-through, so
a HEAD request would have created a draft. HEAD is now normalized to GET before
any handler runs, which makes that whole class of mistake impossible rather than
something each handler has to remember.

### Done — inventory and garbage collection

`inventory.json` in R2 is a tree of every post, its revisions, and its media,
plus orphaned media and pending uploads. `formatTree` prints it readably:

```
node --env-file=.env scripts/inventory.mjs          # print the tree
node --env-file=.env scripts/inventory.mjs --gc     # what would be swept
node --env-file=.env scripts/inventory.mjs --gc --apply
```

The file is **derived, never maintained** — rebuilt from the published index,
draft pointers and the objects actually present, rather than patched as things
change. An incrementally-updated index becomes a second source of truth and
eventually disagrees with reality, which is worst precisely when deciding what
to delete.

Collection is mark-and-sweep and deliberately timid; anything it cannot prove
unreachable, it keeps. Four independent guards:

| Guard | Why |
| --- | --- |
| Current published revision, current draft, its pointer, and any media owned by a live post are always reachable | Losing one loses a post |
| Nothing younger than 1 hour is ever swept | A new object may belong to an upload or publish still in flight |
| `sessions/` and `rate-limits/` are excluded | They expire on their own; sweeping a session signs you out |
| Dry by default, bounded per run | The failure mode is losing work, not wasting bytes |

Retention: superseded published revisions 90 days (the rollback window), draft
history 30 days or 20 revisions per post, unattached uploads 24 hours.

It runs automatically after publish, unpublish and draft discard, and never
throws — a publish that succeeded must not be reported as failed because
housekeeping afterwards did not.

*Why this matters now:* every draft save writes an immutable revision. Without
a sweep, autosave alone would grow the bucket forever.

### Next

Publish: freeze a revision to R2, fire the deploy hook, teach the build to read
from R2, and migrate `content/posts/` out of the repo, auth, uploads,
the editor UI, and finally publication + the migration that empties
`content/posts/` and `assets/images/` into R2.

---

## Design parity

This repo intentionally **duplicates** the main site's look so it can live on a
separate origin. If `souravmishra.net`'s design changes, mirror it here:

- `:root` design tokens and the header/footer/`.nav-bar` chrome live at the top
  of `assets/styles/blog.css` — copied from the main site's `styles/site.css`.
- The SVG icon sprite + nav markup live in `lib/templates.mjs` — copied from the
  main site's `index.html`.

Keeping these in sync is a manual, occasional task; the tokens rarely change.
