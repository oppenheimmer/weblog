# Installing, building, and deploying the blog

This guide covers everything operational: local setup, the build pipeline, the
Cloudflare R2 bucket that holds the content, publishing on **Vercel**, pointing
a domain at it, day-to-day running, and troubleshooting. For the authoring
contract (fields, Markdown/LaTeX, attachments, feed and table) see
[README.md](README.md).

> **Engine here, data in R2.** This repository contains no posts and no media.
> The build reads published posts from a private Cloudflare R2 bucket; a build
> with no R2 credentials produces an empty site rather than failing. Publishing
> happens in the browser at `/editor/`, not by committing files.

---

## 0. Prerequisites

| Requirement | Notes |
| ----------- | ----- |
| **Node 24.x** | Pinned in `.nvmrc` and `engines`. Vercel rejects anything newer; check with `node -v`. |
| **npm** | Ships with Node; installs dependencies and runs the scripts. |
| **git** | The repository is connected to a provider Vercel can import. |
| **Cloudflare R2** | One private bucket (`weblog-data`) holds drafts, attachments, published revisions, sessions and jobs. |
| **Vercel** | One project (`weblog`) serves the static site and the `api/` functions. |
| **Chromium** *(optional)* | Only for the browser verification scripts; set `CHROMIUM` if the binary is not `chromium-browser`. |

No global tools are required — KaTeX, `markdown-it` and `unified-latex` are all
local dependencies installed by `npm install`. There is **no `pandoc`
dependency**; LaTeX is converted in pure JavaScript.

---

## 1. Local setup and build

```bash
git clone <repo-url> website-blog
cd website-blog
npm install        # build dependencies and KaTeX (its CSS and fonts are copied at build)
npm run build      # generate ./dist
npm run dev        # the site and the editor together at http://127.0.0.1:3000 (README, Local development)
npm run clean      # remove ./dist
npm test           # the full suite; needs no credentials
```

What `npm run build` does (`build.mjs`, single pass):

1. Wipes and recreates `dist/`.
2. **Reads the posts.** In order of precedence: `BLOG_POSTS_DIR` if it is set
   (the test and local-fixture path), otherwise R2 if credentials are
   configured, otherwise — on a Vercel preview deployment only — the test
   fixture corpus, otherwise the filesystem, which in a clean clone means no
   posts at all. R2 posts come from `published/index.json` and the frozen revisions it
   names; filesystem posts are `.md`/`.tex` files with `---` frontmatter, and
   `draft: true` skips one.
3. **Fetches and verifies media.** Every image a published revision names is
   downloaded with bounded parallelism, checked against the SHA-256 recorded at
   publish time, and cached by hash under `node_modules/.cache/weblog-media`,
   which Vercel keeps between builds. A missing or mismatched file stops the
   build before any page is written.
4. Renders each body — Markdown via `markdown-it`, LaTeX via `lib/latex.mjs` —
   pre-rendering math with KaTeX so **no client-side math JavaScript is needed**.
5. Sorts posts newest-first and writes:
   - `index.html`, the listing: full articles with a table view of every post,
     continuing at `page/<n>/index.html` once one page's articles exceed about
     350 KB of HTML
   - `<slug>/index.html` per post
   - `tags/<slug>/index.html` per distinct tag, paginated the same way
   - `feed.xml`, `sitemap.xml` (posts **and** tag pages), `robots.txt`, `404.html`
   - `build-manifest.json`, naming the commit and every post revision this build
     contains. The editor reads it back to decide what is actually live, so it
     deliberately carries no timestamp.
6. Copies static assets into `dist/`: `assets/styles/` → `styles/`,
   `assets/images/` → `images/`, `assets/posts/` → `assets/posts/`,
   `assets/vendor/` → `assets/vendor/`, `blog.js`/`editor.js`/`login.js` →
   `assets/`, `favicon.svg`, and KaTeX's `katex.min.css` → `styles/` with its
   fonts at `styles/fonts/`.

`dist/` is gitignored and fully regenerated on every build, locally and on Vercel.

### Building without R2

To build a set of posts with no credentials, keep them outside the repository
and point the build at them (a tripwire test fails if posts or images reappear
inside the repository):

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

These files are treated as repository-authored and trusted, so they may use the
legacy embed hooks described in [README.md](README.md). Posts published from the
browser never can.

---

## 2. Create the R2 bucket

1. In the Cloudflare dashboard, open **R2** and create a bucket named
   `weblog-data`. Leave **public access** and `r2.dev` access **disabled**: the
   build reads it with credentials, and readers only ever see files Vercel
   serves.
2. Create an **API token** scoped to **Object Read & Write** on this bucket
   only. Record its access key id, secret access key and your account id.
3. Add a **CORS policy** (R2 → `weblog-data` → Settings → CORS policy). Browsers
   upload attachments straight to presigned R2 URLs, so without this every
   upload fails at the preflight. The API token cannot set CORS; this is a
   dashboard step:

   ```json
   [{"AllowedOrigins":["https://blog.souravmishra.net"],
     "AllowedMethods":["PUT"],
     "AllowedHeaders":["content-type"],
     "MaxAgeSeconds":3600}]
   ```

   Add any other origin you will run the editor from — a preview deployment or
   `http://127.0.0.1:3000` for `npm run dev` against R2 — as its own entry.
4. Add two **object lifecycle rules** (Settings → Object Lifecycle Rules), each
   deleting objects **1 day after upload**:

   | Rule name | Prefix |
   | --------- | ------ |
   | `expire-sessions` | `prod/sessions/` |
   | `expire-rate-limits` | `prod/rate-limits/` |

   Include the `prod/` segment and the trailing slash; a prefix of `sessions/`
   matches nothing. These records are refused on read once expired regardless,
   so the rules are housekeeping rather than a safety control, and the
   application's token cannot manage them — another dashboard step. Overwriting
   an object resets its lifecycle clock on R2 (measured), and a session in use
   is rewritten at most every 5 minutes of activity, so an active session is
   never deleted from under you.

   To confirm a rule afterwards, write any object under the prefix and read the
   `x-amz-expiration` response header: it names the matching `rule-id` and the
   expiry date. That is the only check available, since the token is refused on
   reading the bucket's lifecycle configuration.

Everything in the bucket lives under a prefix — `prod` in production, `dev`
locally — so local work cannot touch published data. The prefix is
organizational only: a bucket-scoped credential reaches every prefix.

To confirm the bucket behaves as the design assumes, run the capability probe
once (it works under a throwaway prefix and cleans up after itself):

```bash
node --env-file=.env scripts/probe-r2.mjs
```

---

## 3. Set the editor password

```bash
node scripts/set-password.mjs
```

It prompts twice with echo off, refuses to read from a pipe, and prints a
versioned scrypt hash. Paste that into the Vercel project as
`ADMIN_PASSWORD_HASH`. The password itself is never an argument, so it never
reaches shell history, the process list, or a log.

---

## 4. Create the Vercel project

1. Go to <https://vercel.com/new> and **import** the repository.
2. For **Framework Preset**, choose **Other** — this is a custom static
   generator.
3. Leave the build settings alone. `vercel.json` already declares the build
   command (`npm run build`), the output directory (`dist`), clean URLs,
   trailing slashes, the `/editor/` and `/login/` rewrites, and the cache
   headers, so a new project needs no dashboard configuration.
4. Add the environment variables below, **scoped to Production only**. Preview
   and Development deployments then hold no credential at all, which is what
   keeps branch deployments away from production data; a preview builds the
   repository's test fixture posts instead, so it has something to look at, and
   production never does. Keep it that way when adding a variable.

| Variable | Required | Notes |
| -------- | -------- | ----- |
| `R2_ACCOUNT_ID` | Yes | Cloudflare account id. |
| `R2_BUCKET` | No | Defaults to `weblog-data`. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Yes | The R2 token. `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are accepted as aliases. |
| `R2_PREFIX` | Yes | `prod` in production. Defaults to `dev`. |
| `R2_ENDPOINT` | No | Derived from the account id. |
| `ADMIN_PASSWORD_HASH` | Yes | From step 3. Changing it sets a new password **and** ends every session. |
| `AUTH_VERSION` | No | Bump it to revoke every session without changing the password. |
| `RATE_LIMIT_HASH_SECRET` | Yes | Hashes client identifiers in rate-limit keys and signs the device cookie. Rotating it forgets every known browser. |
| `SITE_URL` | No | The public origin: what canonical URLs, Open Graph tags, the feed and the sitemap name, the origin the editor accepts requests from, and the site whose build manifest decides live status. Must be a bare `https://host` origin, or the build stops. Defaults to `https://blog.souravmishra.net`. Set it for both build and functions. |
| `EDITOR_ORIGIN` | No | An additional exact origin allowed to call the API. |
| `VERCEL_DEPLOY_HOOK_URL` | Yes | Fired after publish, unpublish, rollback and Rebuild site. **A secret**: anyone holding it can trigger builds. Absent means the hook is skipped and nothing rebuilds. |
| `PUBLISH_ENABLED` | No | `"false"` refuses publish, unpublish, rollback and rebuild while still listing publications. |

5. Create the deploy hook: **Settings → Git → Deploy Hooks**, targeting the
   production branch (`main`). Copy the URL into `VERCEL_DEPLOY_HOOK_URL`.
   Vercel allows 60 hook calls an hour per project, and calling the hook again
   while a build from the same commit runs cancels the earlier deployment —
   which is how a burst of publishes collapses into one build.
6. Deploy. The first build runs `npm install`, then `npm run build`.

Locally, the same variables live in a gitignored `.env`, and scripts read it
with `node --env-file=.env`. Nothing env-shaped is committed.

---

## 5. Point a domain at the project

1. In the Vercel project, open **Settings → Domains**.
2. Add the domain: `blog.souravmishra.net`.
3. Add the DNS record Vercel shows, wherever DNS for `souravmishra.net` is
   managed:

   | Type | Name | Value |
   | ---- | ---- | ----- |
   | `CNAME` | `blog` | `cname.vercel-dns.com` |

   (Use the exact target Vercel displays — it is occasionally different.)
4. Wait for DNS to propagate; Vercel provisions HTTPS once it verifies the
   record, and **Settings → Domains** turns **Valid**.

> **If the origin changes, two things move together:** `SITE_URL` in the Vercel
> project, which sets canonical URLs, Open Graph tags, the feed and the
> sitemap, the origin the editor accepts requests from and the site the editor
> reads live status back from; and the allowed origin in the R2 bucket's CORS
> rule. Rebuild after changing it, so the pages name the new origin. The
> default, `https://blog.souravmishra.net`, lives in
> [lib/templates.mjs](lib/templates.mjs).

Note that a Vercel project with SSO protection set to "all except custom
domains" leaves the custom domain public while `*.vercel.app` stays gated —
which is what lets the editor read the public build manifest back.

---

## 6. Verify the deployment

Public site:

- `https://blog.souravmishra.net/` — the listing shows full articles
  newest-first, styled like the main site. **Table** switches to a compact table
  of every post, and the choice survives a reload.
- Open a post — math, highlighted code and heading anchors render. **Disable
  JavaScript and reload**: the math is still there, pre-rendered at build time,
  and the feed still reads.
- Click a **tag chip** — `/tags/<slug>/` lists only that tag's posts.
- `/feed.xml` and `/sitemap.xml` load as valid XML, the sitemap including tag
  pages.
- `/build-manifest.json` names the commit and the revisions this build contains.

Editor:

- `/login/` accepts the password and redirects to `/editor/`; a wrong password
  is refused without saying why.
- `/editor/` signed out redirects to `/login/`, and `/api/drafts/` answers 401
  with no session.
- An attachment uploads, previews and publishes. If the upload fails at the
  preflight, the R2 CORS rule in step 2 is missing or names the wrong origin.

Interactives, once one is published:

```bash
node scripts/verify-live-bundles.mjs
```

It reads the live site anonymously. Run preview addresses must reach the
preview function; each published lab must answer with `sandbox allow-scripts`
and `Access-Control-Allow-Origin: *` and land on its own directory, each figure
module with the sandbox policy, and the editor, login and API with no
`Access-Control-Allow-Origin`. Vercel sends that header with every static file
itself, so public pages carry it; it never admits a read with cookies. Without
a published interactive it checks the Run addresses only and exits 2.

---

## 7. Day-to-day publishing

There is no repository step and no terminal step.

1. Sign in at **`/login/`**, write at **`/editor/`**.
2. Fill in title, date and format; slug, description and tags are optional.
   A whole document pasted with `---` frontmatter imports those safe fields and
   its body; **Import source** accepts `.md`, `.markdown` and `.tex` files.
   Attach images or `.tex` snippets with the attach button, by pasting, or by
   dropping them on the page. Each attachment's reference is inserted on a line
   of its own. Image alt text is editable before Insert, and a missing reference
   can be relinked to a verified attachment of the same kind. **Interactives**
   attaches a lab or figure folder, replaces or removes one, and puts one of
   its last three revisions back (README, *Interactive posts*).
3. **Preview** renders the fields as they would publish, in a sandboxed frame.
   Its errors are exactly what publishing would refuse; render warnings — an
   unsupported LaTeX command, a formula that did not parse — never block
   publishing. With an interactive attached, **Run interactives** runs them in
   that frame, still without access to the editor.
4. Changes autosave after a short quiet period; **Save** makes an immediate
   checkpoint. **Publish** saves first, freezes that revision into R2,
   updates the published index, and fires the deploy hook.
   The line beside Publish says beforehand what it will publish — the
   address, images, snippets and interactives — or why it would refuse.
5. **On the site** reads the live build manifest back and reports Live, Not live
   yet, Updating, Coming down, Unpublished or Not checked. It keeps checking —
   after 4 seconds, then less often, up to every 30 seconds — and after 15
   minutes says the build may have failed.

From the same panel: **Unpublish** takes a post off the site while keeping its
revisions, and **Roll back** (or **Put back**) puts a stored revision on the
site. Put back defaults to the revision last shown, including after an editor
reload. A publication-only post offers **Edit as draft**, which branches the
selected stored revision under the same post identity. **Rebuild site** sits beside the publication list rather than in the
panel, since it is about the site and not a post, and is offered even when
nothing is published. It rebuilds and sweeps what nothing needs any more,
reporting what it removed; it pauses 30 seconds after a click, to stay inside
Vercel's hourly hook limit.

Pushing to `main` rebuilds the engine with the same content; publishing rebuilds
the same engine with new content. Both go through the same build.

### Pushing a staged post from a terminal

A post written on disk, with its interactive figures or labs, can be pushed
from a folder instead of attached in the editor. Stage one post per folder
under `staging/` (gitignored): its `.md` source and one subfolder per
`::demo[<folder>]` or `::figure[<folder>]` it names. README's *Pushing a post
with its interactives* describes the layout.

```bash
node --env-file=.env scripts/push.mjs staging/<post>            # dry run
node --env-file=.env scripts/push.mjs staging/<post> --apply    # push and clear
```

`R2_PREFIX` decides where it lands: `prod` is the live site, and the dry run
prints the bucket and prefix first. The push goes through the editor's own
draft, upload and publish services, fires the deploy hook, then reads every
staged file back from R2 and deletes what matches, the source last. While
anything is staged, `npm test` fails its engine-purity tripwire on purpose.

- **It refused.** Nothing was written. The message names the file or field.
- **It stopped before publishing.** Nothing was removed; fix the cause and run
  it again. Uploaded folders are not transferred twice.
- **It kept files.** The post is published. Each kept file is listed with its
  reason; run the push again to send a change or finish removing the rest.
- **A draft has unpublished changes.** Publish or discard them in the editor, or
  pass `--replace-draft`; the replaced revisions stay in the draft's history.
- **Several drafts share the address.** Pass `--post <postId>`.

A folder whose bytes match an earlier stored revision puts that revision back.
An interactive the post has and the source no longer names is removed after the
post publishes; the dry run lists it as `remove`, and a push that stops before
publishing removes nothing.

---

## 8. Operations

### Inventory and garbage collection

```bash
node --env-file=.env scripts/inventory.mjs               # print the tree
node --env-file=.env scripts/inventory.mjs --gc          # what would be swept
node --env-file=.env scripts/inventory.mjs --gc --apply  # sweep
```

`inventory.json` is derived from the bucket on every run, never maintained
incrementally. Collection is scoped to one post at a time by the post id in
every key, is dry by default, and never touches the current published revision,
the current draft, or anything younger than an hour. Retention: superseded
published revisions 90 days (the rollback window), draft history 30 days or 20
revisions per post, unattached uploads 24 hours, publication jobs 30 days once
the index no longer names their revision, or an hour once their post is gone.
An interactive keeps its three most recently used bundle revisions, and a
published bundle copy goes a day after the last stored revision naming it; if
any of those facts cannot be read, no bundle of that post is touched. It runs
automatically after publish, unpublish, rollback, draft discard and Rebuild
site, and never throws.

Expired sessions and rate-limit windows are not collected here: the R2
lifecycle rules in §2 delete them.

### Quotas worth knowing

The Vercel team is on the **Hobby** plan, and every team-scoped limit is shared
with the other projects in it. Exceeding an included allowance pauses that
feature for **30 days**, team-wide — so the limits that matter are the ones an
outsider can drive, not the ones ordinary writing touches.

| Allowance | Hobby / R2 free tier | What this blog uses |
| --------- | -------------------- | ------------------- |
| R2 storage, Class A, Class B | 10 GB, 1M, 10M per month | About 0.1% of Class A in a heavy month |
| Function invocations, edge requests | 1M each per month | Editor polling and reader traffic; far below |
| **Active CPU** | **4 CPU-hours per month** | Almost entirely password checks — see below |
| Deployments | 100 per day, team-wide | One per publish, unpublish, rollback, rebuild or push |
| Deploy-hook triggers | 60 per hour, per project | Why **Rebuild site** pauses 30 seconds |
| Runtime logs | kept 1 hour | Read a failed build's log promptly or lose it |

One password verification costs about 257 ms of CPU by design, so the monthly
allowance is roughly 56,000 of them. The in-app limiter caps anonymous attempts
at 50 per 15 minutes, which is 4,800 a day — a spray held at that ceiling would
spend more CPU in a month than Hobby includes, and would need about twelve
uninterrupted days to get there. Nothing else is close: rendering a maths-heavy
post costs 4.7 ms, so **a login is roughly 55 times more expensive than serving
a post**. That is the first place to look if compute usage ever seems strange.

This is a watch item, not a live problem: usage notifications arrive
automatically, and upgrading to Pro replaces the 30-day pause with on-demand
billing. If it ever needs fixing rather than paying for, a Vercel Firewall rate
rule on `/api/auth/login/` is the cheapest answer, because it refuses the
request before a function starts.

### Backups, and restoring from one

Git holds no content, so R2 is the only copy. Take dated backups with a
**separate read-only** R2 token that never goes into Vercel.

Configure the remote once (`rclone config`, or write it directly):

```ini
# ~/.config/rclone/rclone.conf
[r2]
type = s3
provider = Cloudflare
access_key_id = <read-only token id>
secret_access_key = <read-only token secret>
endpoint = https://<account id>.r2.cloudflarestorage.com
region = auto
no_check_bucket = true
```

Then:

```bash
rclone copy r2:weblog-data/prod ./backup/prod-$(date +%F) --transfers 8
```

**A backup nobody has restored is not a backup.** The whole procedure —
back up, lose everything, restore, rebuild — is rehearsed by a script that
works under throwaway prefixes on the real bucket and never touches `prod/`:

```bash
node --env-file=.env scripts/verify-restore.mjs            # 10 checks
node --env-file=.env scripts/verify-restore.mjs --control  # damage the backup on purpose
```

It seeds two published posts (one with an image), a draft and a superseded
revision, builds the site, copies the prefix out with the same `rclone copy`
above, deletes every object, confirms the site is genuinely gone, restores into
a **different** prefix, and rebuilds. The proof is that the rebuilt site is
byte-identical to the site before the loss. The `--control` run deletes one file
from the backup first and passes only if the checks notice.

To restore for real: stop publishing, `rclone copy ./backup/prod-<date>
r2:weblog-data/prod`, then **Rebuild site** in the editor. Restoring into a new
prefix or bucket works equally well — nothing in the data depends on where it
used to live; change `R2_PREFIX` and redeploy. An incomplete restore does not
ship a broken site: the build refuses to continue when a published revision
names media it cannot find.

### Rotating credentials

| To do this | Do this |
| ---------- | ------- |
| Change the password | `node scripts/set-password.mjs`, then update `ADMIN_PASSWORD_HASH`. Every session ends. |
| Revoke every session, keeping the password | Bump `AUTH_VERSION`. |
| Rotate the R2 token | Create the new token, update both `R2_*` variables, redeploy, then delete the old token. |
| Rotate the deploy hook | Delete it in **Settings → Git → Deploy Hooks**, create another, update `VERCEL_DEPLOY_HOOK_URL`. |
| Rotate `RATE_LIMIT_HASH_SECRET` | Set a new value. Every browser's device cookie stops counting separately, so signed-in browsers fall back to the per-address budget. |

### Locked out of login

Five failed attempts from one address, or 50 anonymous attempts in total,
exhaust a 15-minute window. **The ordinary recovery is to wait**: the window
expires on its own. A browser that has signed in before carries a signed device
cookie and has its own budget of five, so other people's failures cannot lock it
out. In an emergency, changing `ADMIN_PASSWORD_HASH` sets a new password and
ends every session. There is no bypass secret, deliberately — it would be a
second credential of equal power that never gets rotated.

### Sessions

Idle timeout is 8 hours, refreshed on activity, with a hard 7-day ceiling.
Expiry is enforced on every read, so a record that outlives its deadline never
authenticates even if cleanup has not run.

### Request logs

Every API request writes one JSON line to the function's runtime log: its
`requestId` (the same one an error response carries), method, path, status,
duration, commit and deployment, and — where they apply — the post, job,
revision, upload, attachment or bundle id and the action or refusal code. Filter
the project's **Logs** view in Vercel by `requestId` or a post id. Lines never
contain a password, cookie, CSRF token, signed URL, draft text or a refusal's
message. The Hobby plan keeps runtime logs for **one hour**, so look soon after
something goes wrong; what changed on the site is recorded durably in R2 as
publication jobs and the build's failure record.

### A failed build

Vercel keeps the previous deployment serving, and the draft and publication job
both survive. Publish again to re-fire only the hook, or use **Rebuild site**.

**The editor names the failure.** A build that fails writes its reason to
`<prefix>/builds/last-failure.json`, and the panel shows it with a link to the
deployment list — so a missing image or an unrenderable post is reported where
you already are, rather than only in a build log the Hobby plan discards after
an hour. A build that succeeds deletes the record, so it can never accumulate
and its presence always means the most recent build failed.

Two failures it cannot name, because they happen before the build's own code
runs: a dependency install that fails, and a platform timeout. For those the
panel falls back to saying nothing has landed in 15 minutes and no failure was
recorded, which points at the deployment list.

---

## 9. Verification scripts

`npm test` runs the whole suite with no credentials. Beyond it:

```bash
node scripts/verify-listing.mjs          # feed and table: keyboard, phones, no JS
node scripts/verify-preview-sandbox.mjs  # the preview frame cannot run script
node scripts/verify-editor.mjs           # writing flow and On the site panel, against a stand-in site
node scripts/verify-editor-access.mjs    # file drop, clipboard paste, sign-out, keyboard and accessibility tree
node scripts/verify-editor-interactives.mjs  # attach, replace and remove folders; Run preview stays out of the editor
```

Those drive Chromium over the DevTools protocol; set `CHROMIUM` if the binary is
not `chromium-browser`.

CI runs the first group automatically: `.github/workflows/ci.yml` on every push
and pull request, with the browser checks on `main`, and `audit.yml` weekly for
production advisories. Neither workflow is given a secret.

The scripts below are **not** in CI, deliberately — scheduling them would mean
storing an R2 credential in GitHub:

```bash
node --env-file=.env scripts/probe-r2.mjs        # R2 capability probe
node --env-file=.env scripts/verify-store.mjs    # storage layer against real R2
node --env-file=.env scripts/verify-publish.mjs  # publish, unpublish, roll back, build
node --env-file=.env scripts/verify-uploads.mjs  # presigned uploads and CORS
node --env-file=.env scripts/verify-push.mjs     # staging push: bundles, publish, clear
node --env-file=.env scripts/verify-restore.mjs # back up, lose everything, restore, rebuild
```

Each works under a throwaway prefix on the real bucket and cleans up after
itself.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| Build error: `katex.min.css not found` | Dependencies not installed in the build environment. Ensure `npm install` runs before `npm run build`. |
| The site builds but is **empty** | No R2 credentials in that environment, or nothing published. A credential-less build produces an empty site by design; check the build log's `content:` line. |
| Build aborts: *Media error* | A published revision names an image that is missing from R2 or whose bytes no longer match its recorded hash. The build refuses rather than shipping a broken page. |
| Build aborts: *Content error* | A post failed validation — a missing title or date, an unparseable date, a reserved or duplicate slug. The message names the post. |
| A post doesn't appear | It was never published (a saved draft is not published), or it is unpublished. Check **On the site** in the editor, and `/build-manifest.json`. |
| Publish succeeds but the post is not live | The rebuild has not landed, or the deploy hook is unset or failed. The panel distinguishes them; **Rebuild site** re-fires the hook. |
| Attachment upload fails immediately | The R2 CORS rule is missing, or does not name the exact origin the editor is served from (step 2). |
| Publishing under a new slug is refused | A published post's slug is fixed. Unpublish it first, or keep the slug. |
| Discarding a draft is refused | Its post is still published; the draft and the published copy share a post id. Unpublish first. |
| Login returns 429 | The rate-limit window. Wait it out, or rotate `ADMIN_PASSWORD_HASH`; see §8. |
| `/api/…` returns 403 with no obvious cause | The request's `Origin` did not match exactly, or its CSRF token was missing. Origins are matched exactly, never by suffix. |
| Math shows as raw `$…$` text | The expression failed to parse. KaTeX runs with `throwOnError: false`; check the delimiters, and the preview warnings. |
| `.tex` heading looks too small | `\section` maps to `<h3>` by `unified-latex` default. Cosmetic; adjust in `lib/latex.mjs` if it matters. |
| Styles look wrong after a main-site redesign | Re-mirror tokens and chrome — see **Design parity** in [README.md](README.md). |
| An old image is still served after replacing it | Published images are revalidated rather than immutable, but CDN and browser caches still apply. Attachment names are never reused within a post, so a replaced image normally gets a new name. |

---

## Dependencies (reference)

Installed by `npm install`; pinned in `package.json`:

- `markdown-it` + `markdown-it-anchor` + `markdown-it-texmath` — Markdown,
  anchors and math delimiters
- `katex` — build-time math rendering, and the CSS and fonts copied into `dist/`
- `highlight.js` — build-time code highlighting
- `gray-matter` — `---` YAML frontmatter parsing, for filesystem builds
- `unified` + `rehype-stringify` +
  `@unified-latex/unified-latex-util-parse` + `@unified-latex/unified-latex-to-hast`
  — the pure-JavaScript LaTeX → HTML pipeline
- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — R2 over its
  S3-compatible API, including presigned upload URLs

The only runtime assets shipped to readers are the small `assets/blog.js`
(mobile nav, feed/table switch, clickable rows, scroll reveal) and any per-post
embeds; `editor.js` and `login.js` load only on the authenticated pages. There is
no framework runtime.
