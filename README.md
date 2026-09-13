# WeBlog

A small engine for a personal blog. Posts are written in a browser editor,
stored in Cloudflare R2, and built into static HTML on Vercel: maths rendered
by KaTeX at build time, highlighted code, tag pages, a full-article feed with a
table view, RSS and a sitemap.

- **Input:** published posts in R2. The repository holds none.
- **Output:** a static `dist/` with clean URLs and no runtime framework.
- **Publishing:** write at `/editor/`, press Publish, and the site rebuilds.

> **Engine in git, data in R2.** Cloning the repository gives you the engine
> and nothing to read. A build without R2 credentials produces an empty site
> rather than failing.

First-time setup, deployment and operations are in [INSTALL.md](INSTALL.md).

---

## Writing a post

Sign in at `/login/` and write at `/editor/`. There is no repository or
terminal step.

| Field       | Required | Notes                                          |
| ----------- | -------- | ---------------------------------------------- |
| Title       | Yes      |                                                |
| Date        | Yes      | Ordering, display and the feed                 |
| Format      | Yes      | Markdown or LaTeX                              |
| Slug        | No       | Derived from the title; some routes reserved   |
| Description | No       | Meta tags, social cards, RSS; derived if empty |
| Tags        | No       | Comma-separated; each tag gets a page          |

- **Import.** Paste a whole document starting with `---`, or use **Import
  source** on a `.md`, `.markdown` or `.tex` file, and its fields fill in.
- **Saving.** Changes autosave after a moment of quiet; **Save** (Ctrl/Cmd-S)
  saves now. If another tab saved the same draft, a dialog asks which to keep.
  **Export source** downloads the text, even after the session has ended.
- **Preview** shows the post as it will publish. What Publish would refuse
  shows as an error; what would not render as written, such as a broken
  formula, shows as a warning. Warnings never block publishing.
- **Beside Publish**, a line says what it would do, for example *Ready to
  publish at /your-slug/ with 2 images*, or why it would refuse.

### Markdown

- Maths: `$inline$` and `$$display$$`, rendered by KaTeX when the site builds.
- Fenced code blocks are highlighted with highlight.js.
- Headings `##`–`####` get anchor links.
- Raw HTML is shown as text, never rendered. Links accept `http`, `https`,
  `mailto` and relative URLs; images must be attachments.

### LaTeX

Choose **LaTeX** and write the document body, with no preamble:

```latex
\section{Heading}
Inline maths $E = mc^2$ and display maths:
\[ \int_0^1 x\,dx = \tfrac12 \]
```

It is converted in-process by `unified-latex`, with maths by the same KaTeX.
`\section` becomes an `<h3>`. Commands the converter does not support, such
as `\ref`, `\cite`, `\footnote` or `align`, appear as preview warnings. A
document that takes more than ten seconds to render is refused.

### Images and `.tex` snippets

Attach files with the attach button, by pasting, or by dropping them on the
page. The editor inserts the reference on its own line:

| Attachment     | Markdown                    | LaTeX                                    |
| -------------- | --------------------------- | ---------------------------------------- |
| Image          | `![alt](attachment://<id>)` | `\includegraphics{attachments/<id>.png}` |
| `.tex` snippet | `::tex[<id>]`               | `\input{attachments/<id>.tex}`           |

- Images: PNG, JPEG, GIF or WebP, up to 10 MiB. Snippets: UTF-8, up to
  256 KiB. At most 25 attachments and 50 MiB per post.
- Files are identified by their bytes, not their names, and upload straight to
  R2.
- A published image lives at `/images/uploads/<slug>/<name>`, under a readable
  name (`image.png`, then `image-2.png`).
- If the text names an attachment that is gone, **Relink** offers a
  replacement of the same kind.

### Feed and table

The home page and each tag page show posts two ways, switched by **Feed /
Table**. The feed, the default, shows full articles newest first, and
continues at `/page/2/` past about 350 KB of HTML. The table lists every post
with its date and tags. The choice is remembered, and `?view=feed` or
`?view=table` overrides it.

---

## Publishing and the site

**On the site** reads back what the live site is serving, rather than assuming
a publish worked:

| State        | Meaning                                              |
| ------------ | ---------------------------------------------------- |
| Live         | The site shows the revision last published           |
| Not live yet | Published; the rebuild has not landed                |
| Updating     | The site still shows an earlier revision             |
| Coming down  | Unpublished; the site shows it until the rebuild     |
| Unpublished  | Off the site; its revisions are kept for 90 days     |
| Not checked  | The site could not be read, and the panel says why   |

The editor keeps checking after each change. A build that fails records why,
and the panel shows the reason with a link to the deployment log.

- **Unpublish** takes a post off the site and keeps its revisions.
- **Roll back** puts a stored revision back on the site. For an unpublished
  post the same button reads **Put back**.
- **Edit as draft** opens a published post that has no draft.
- **Rebuild site** rebuilds without changing a post, and clears out what
  nothing needs any more.
- **Discard draft** deletes a post's draft, revisions, attachments and
  interactives. It is refused while the post is published.

A published post keeps its slug until it is unpublished. The sidebar lists
published posts under **On the site**, and everything the site does not show
under **Drafts**: new posts, unpublished posts, and saved changes to a
published post, which then appears in both lists.

---

## Interactive posts

A Markdown post can include two kinds of interactive, each an uploaded folder:

| Kind           | Markdown         | Use it for                                     | Runs                    |
| -------------- | ---------------- | ---------------------------------------------- | ----------------------- |
| Article figure | `::figure[<id>]` | A Distill-style figure tied to the article     | In the post page        |
| Lab            | `::demo[<id>]`   | A self-contained simulation or tool            | In a sandboxed iframe   |

- **A figure** is a `.mjs` module exporting `mount(root, context)`. It runs
  with the page's own access, so it can react to the article and scrolling.
- **A lab** is a small web folder with an `index.html`. It runs sealed: it
  cannot read the article, the editor or the session, even opened directly.
- **Both** need a `fallback.html`, shown in the feed, in print, without
  JavaScript, and while loading. Neither runs in listings.
- **Libraries** are named, never linked: a figure may declare `distill` or
  `d3`, both served from this site. Outside scripts and data are refused.
- **Maths** in the post body is always rendered by KaTeX when the site builds.
  Distill's `<d-math>` is for maths a figure creates or changes as it runs.

```text
double-pendulum/
├── index.html        the lab's entry (a figure's is main.mjs)
├── fallback.html     the static version
├── interactive.json  optional: {"entry": "...", "dependencies": ["d3"]}
├── demo.js
└── equations.json
```

In the editor, **Attach lab folder** or **Attach figure folder** uploads a
folder and inserts its reference. Each interactive row offers **Insert**,
**Replace** (a new revision) and **Remove**, and keeps its last three
revisions, any of which **Use** puts back. Changes reach the site at the next
Publish.

The preview never runs code on its own. **Run interactives** runs them in the
preview, still sealed off from the editor; **Stop interactives** shows edits.

### From a folder on disk

`scripts/push.mjs` publishes a post and its interactives from one folder,
through the same checks as the editor:

```text
staging/double-pendulum/
├── post.md      frontmatter and body, naming ::demo[lab] and ::figure[energy]
├── lab/
└── energy/
```

```bash
node --env-file=.env scripts/push.mjs staging/double-pendulum          # dry run
node --env-file=.env scripts/push.mjs staging/double-pendulum --apply  # push
```

It refuses before writing anything if a file would be left behind. After
publishing, it reads every file back from R2 and deletes the local copies that
match, so the folder ends empty. A failed push deletes nothing and can be run
again. Interactives the post no longer names are removed.

---

## Local development

```bash
npm install         # one time
npm run dev         # site and editor together at http://127.0.0.1:3000
npm run build       # generate ./dist
npm test            # the full suite; needs no credentials
npm run test:bless  # re-record golden output after an intended change
```

Requires **Node 24.x** (`.nvmrc`).

`npm run dev` serves the site under `vercel.json`'s rules with the real editor
functions, and rebuilds locally when you publish. With R2 credentials in
`.env` it uses the bucket under `R2_PREFIX` (`dev` by default; `prod` needs
`--allow-prod`). Without them, or with `--memory`, it uses an in-memory bucket
that is forgotten on exit. The password is `ADMIN_PASSWORD_HASH`'s, or one it
prints.

To build posts from a local directory instead of R2:

```bash
BLOG_POSTS_DIR=/path/to/posts BLOG_DIST_DIR=/tmp/dist npm run build
```

Each file there is `.md` or `.tex` with frontmatter (`title`, `date`, and
optionally `description`, `tags`, `slug`, `draft: true`). Local posts are
trusted: they may contain raw HTML and set `styles`, `scripts`, `head` and
`distill` hooks. Editor posts never can.

### Checks

Browser checks need Chromium (`CHROMIUM` if it is not `chromium-browser`):

```bash
node scripts/verify-listing.mjs              # feed and table
node scripts/verify-preview-sandbox.mjs      # preview runs no script
node scripts/verify-editor.mjs               # writing flow and On the site
node scripts/verify-editor-access.mjs        # keyboard, drop, paste, sign-out
node scripts/verify-editor-interactives.mjs  # folders and Run preview
node scripts/verify-demo-sandbox.mjs         # labs sealed, figures mounted
node scripts/verify-public-csp.mjs           # public page policy, Distill
```

These use the real bucket under a throwaway prefix and clean up after
themselves:

```bash
node --env-file=.env scripts/verify-store.mjs    # storage layer
node --env-file=.env scripts/verify-publish.mjs  # publish, roll back, build
node --env-file=.env scripts/verify-uploads.mjs  # uploads and CORS
node --env-file=.env scripts/verify-push.mjs     # the staging push
node --env-file=.env scripts/verify-restore.mjs  # backup and restore
```

After a deploy, `node scripts/verify-live-bundles.mjs` checks the live site's
interactive headers. CI runs the suite and the browser checks on every push to
`main`, with no secrets.

---

## Deploying

One Vercel project serves the static `dist/` and the functions in `api/`
(`/login/`, `/editor/`, `/api/*`). Build settings, rewrites and headers are in
`vercel.json`. Pushing to `main` rebuilds with the same posts; publishing a
post rebuilds with the same code.

`SITE_URL` sets the public address used in canonical links, the feed, the
sitemap and the editor's allowed origin. It defaults to
`https://blog.souravmishra.net`. If it changes, also update the R2 bucket's
CORS rule. Environment variables are listed in [INSTALL.md](INSTALL.md).

---

## How it works

| Path                  | Responsibility                                          |
| --------------------- | ------------------------------------------------------- |
| `build.mjs`           | Reads published posts and media, writes `dist/`         |
| `lib/content.mjs`     | Source text to a validated, rendered post               |
| `lib/markdown.mjs`    | Markdown: KaTeX, highlighting, anchors, link rules      |
| `lib/latex.mjs`       | LaTeX to HTML, with a time limit                        |
| `lib/sanitize.mjs`    | What browser-written content may contain                |
| `lib/interactives.mjs` | The interactive folder contract                        |
| `lib/templates.mjs`   | Page shell, listings, SEO, site chrome (`SITE`)         |
| `lib/server/`         | Storage, drafts, uploads, publishing, preview, sign-in  |
| `api/`                | Vercel functions                                        |
| `assets/`             | Styles and scripts; vendored Distill and D3             |
| `scripts/`            | Dev server, push, checks, password setup, inventory     |
| `test/`               | Golden output, contracts, tripwires, unit tests         |

```text
dist/
  index.html, page/<n>/   the feed and table
  <slug>/                 one page per post
  tags/<slug>/            one page per tag
  images/uploads/<slug>/  published images
  assets/figures/, demos/ published interactives
  feed.xml  sitemap.xml  robots.txt  404.html
  build-manifest.json     which post revisions this build holds
```

Design points worth knowing:

- **One pipeline.** Preview, publishing and the build share the same
  rendering and validation, so they cannot disagree.
- **Nothing is overwritten.** Every save writes a new immutable revision and
  moves a pointer with a conditional write; two tabs get a conflict, never a
  silent loss. Publishing writes the revision, updates the published index
  (the commit point), then fires the deploy hook.
- **Live status comes from the site.** The editor reads `/build-manifest.json`
  from the public site; no Vercel token is needed.
- **Sign-in.** One scrypt-hashed password, sessions stored only as token
  hashes (8 hours idle, 7 days at most), CSRF tokens, and login attempts
  counted in R2 before the password is checked.
- **The editor shares the site's origin**, so browser-written posts cannot
  carry script, the preview frame is sandboxed, and editor pages send a strict
  CSP. Article figures are the one deliberate exception, and only for folders
  the owner attached.
- **Cleanup is scoped to one post.** Every object's key carries its post id,
  so deleting or sweeping one post cannot touch another. The inventory is
  rebuilt from what exists, never maintained. Superseded published revisions
  stay 90 days, draft history 30 days or 20 revisions, unfinished uploads a
  day; nothing under an hour old is swept.

Site chrome — colours, header, footer and icons — lives at the top of
`assets/styles/blog.css` and in `lib/templates.mjs`.
