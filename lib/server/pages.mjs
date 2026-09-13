// Server-rendered HTML for the login and editor pages (CLAUDE.md §3.1, Step 5).
//
// These are functions, never static files: the editor markup must not be
// reachable without a session, and a file in dist/ would be.
//
// Both pages reuse the public stylesheet for design parity and add their own on
// top, so the editor looks like the blog rather than like a control panel.
import { escapeHtml, SITE } from "../templates.mjs";
import { readR2Config } from "./config.mjs";

/**
 * Content-Security-Policy for the editor pages.
 *
 * §3.1 records why this is required rather than nice to have: the editor shares
 * an origin with published posts that can carry custom JavaScript, so an XSS in
 * a post is an editor-session compromise. No inline script is permitted — the
 * editor's own code is a same-origin file.
 */
export const EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/**
 * The origin that presigned upload URLs point at.
 *
 * Virtual-hosted, not the endpoint: the SDK signs
 * https://<bucket>.<account>.r2.cloudflarestorage.com/…, so a connect-src naming
 * only the endpoint would block every upload in the browser while every
 * server-side test stayed green. test/uploads.test.mjs pins this against a URL
 * the real signer produced.
 */
export function uploadOrigin(env = process.env) {
  const { endpoint, bucket } = readR2Config(env);
  if (!endpoint || !bucket) return null;
  try {
    return `https://${bucket}.${new URL(endpoint).host}`;
  } catch {
    return null;
  }
}

/**
 * The editor CSP, widened only as far as the editor's own features need.
 *
 * `upload` admits the storage origin for the browser's direct PUT. `preview`
 * admits what a rendered post needs inside the sandboxed srcdoc frame, which
 * inherits this policy: images signed by storage, the KaTeX fonts this site
 * serves, and inline style *attributes*, which KaTeX uses for layout.
 *
 * Measured in Chromium, not assumed: under the upload-only policy the preview's
 * maths collapsed and its fonts and images were blocked. Style *elements* and
 * every form of inline script stay blocked either way.
 */
export function editorCsp({ upload = null, preview = false } = {}) {
  let policy = EDITOR_CSP;
  if (upload) policy = policy.replace("connect-src 'self'", `connect-src 'self' ${upload}`);
  if (preview) {
    policy = policy
      .replace("img-src 'self' data: blob:", `img-src 'self' data: blob:${upload ? ` ${upload}` : ""}`)
      .replace("font-src https://fonts.gstatic.com", "font-src 'self' https://fonts.gstatic.com")
      .replace("style-src 'self' https://fonts.googleapis.com",
        "style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'");
  }
  return policy;
}

/** Headers every editor page sends. Only the editor itself talks to storage or previews. */
export function pageHeaders({ uploads = false, preview = false } = {}) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": editorCsp({ upload: uploads || preview ? uploadOrigin() : null, preview }),
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    // The editor must never appear in a search index.
    "x-robots-tag": "noindex, nofollow",
  };
}

function shell({ title, bodyClass = "", body, script }) {
  return `<!DOCTYPE html>
<html lang="${SITE.lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Source+Sans+3:wght@400;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/styles/blog.css" />
  <link rel="stylesheet" href="/styles/editor.css" />
</head>
<body class="editor-body ${bodyClass}">
${body}
${script ? `<script type="module" src="${script}"></script>` : ""}
</body>
</html>
`;
}

export function loginPage({ error = "" } = {}) {
  return shell({
    title: `Sign in — ${SITE.title}`,
    bodyClass: "login-page",
    script: "/assets/login.js",
    body: `
    <main class="auth-shell">
      <form class="auth-card" id="login-form" method="post" action="/api/auth/login/" novalidate>
        <h1 class="auth-title">${escapeHtml(SITE.author)}</h1>
        <p class="auth-sub">Editor sign-in</p>

        <label class="field">
          <span class="field-label">Password</span>
          <input type="password" id="password" name="password" autocomplete="current-password"
                 required autofocus aria-describedby="login-error" />
        </label>

        <button type="submit" class="button" id="login-submit">Sign in</button>

        <p class="auth-error" id="login-error" role="alert" aria-live="polite">${escapeHtml(error)}</p>
      </form>
    </main>`,
  });
}

export function editorPage() {
  return shell({
    title: `Editor — ${SITE.title}`,
    bodyClass: "editor-page",
    script: "/assets/editor.js",
    body: `
    <header class="editor-bar">
      <div class="editor-bar-left">
        <a class="editor-brand" href="/" title="View the blog">${escapeHtml(SITE.author)}</a>
        <h1 class="editor-tag">Editor</h1>
      </div>
      <div class="editor-bar-right">
        <span class="save-state" id="save-state" role="status" aria-live="polite"></span>
        <button type="button" class="button button-secondary" id="new-post">New post</button>
        <button type="button" class="button button-secondary" id="logout">Sign out</button>
      </div>
    </header>

    <main class="editor-layout">
      <aside class="editor-sidebar" aria-label="Posts">
        <h2 class="sidebar-title">Drafts</h2>
        <ul class="draft-list" id="draft-list"></ul>
        <p class="sidebar-empty" id="draft-empty" hidden>No unpublished drafts.</p>

        <h2 class="sidebar-title sidebar-section">On the site</h2>
        <ul class="draft-list" id="publication-list"></ul>
        <p class="sidebar-empty" id="publication-empty" hidden>Nothing published yet.</p>

        <!-- Rebuilding is about the site, not about a post, so it lives here
             rather than inside the per-post panel, which is hidden until a
             published post is selected. With nothing published that panel never
             appears, and this was the one action still needed. -->
        <button type="button" class="button button-secondary button-small sidebar-action"
                id="publication-rebuild">Rebuild site</button>
        <p class="sidebar-note" id="rebuild-note" role="status" aria-live="polite"></p>
      </aside>

      <section class="editor-main" aria-label="Post editor">
        <div class="editor-fields">
          <label class="field field-wide">
            <span class="field-label">Title</span>
            <input type="text" id="title" autocomplete="off" />
          </label>

          <label class="field">
            <span class="field-label">Date</span>
            <input type="date" id="date" />
          </label>

          <label class="field">
            <span class="field-label">Format</span>
            <select id="format">
              <option value="markdown">Markdown</option>
              <option value="latex">LaTeX</option>
            </select>
          </label>

          <label class="field field-wide">
            <span class="field-label">Slug <span class="field-hint" id="slug-preview"></span></span>
            <input type="text" id="slug" autocomplete="off" placeholder="derived from the title" />
          </label>

          <label class="field field-wide">
            <span class="field-label">Description</span>
            <input type="text" id="description" autocomplete="off" />
          </label>

          <label class="field field-wide">
            <span class="field-label">Tags <span class="field-hint">comma separated</span></span>
            <input type="text" id="tags" autocomplete="off" />
          </label>
        </div>

        <div class="writing" id="writing" data-preview="off">
          <!-- Not one <label> around all of it: a label that also holds the
               Import button gave the textarea no accessible name at all in
               Chromium's tree, so a screen reader announced an unnamed field. -->
          <div class="field field-body">
            <span class="source-head">
              <label class="field-label" for="body">Body</label>
              <span>
                <button type="button" class="button button-secondary button-small" id="import-source">Import source</button>
                <input type="file" id="import-source-input" hidden
                       accept=".md,.markdown,.tex,text/markdown,text/x-tex,text/plain" />
              </span>
            </span>
            <textarea id="body" spellcheck="true" aria-describedby="editor-error"></textarea>
          </div>

          <section class="preview-pane" id="preview-pane" aria-labelledby="preview-title" hidden>
            <div class="preview-head">
              <h2 class="preview-title" id="preview-title">Preview</h2>
              <span class="preview-state" id="preview-state" role="status" aria-live="polite"></span>
              <!-- Run executes the post's interactives in this frame, which
                   assets/editor.js then sandboxes with scripts but still no
                   origin of its own (§3.6). Shown once a bundle is attached. -->
              <button type="button" class="button button-secondary button-small" id="preview-run"
                      aria-pressed="false" hidden>Run interactives</button>
            </div>
            <ul class="diagnostics" id="diagnostics" hidden></ul>
            <!-- sandbox="" with no allow-* tokens: the preview can neither run script
                 nor reach this page (§3.1). Checked in Chromium, not assumed: without
                 the attribute, a same-origin script placed in the preview runs. -->
            <iframe class="preview-frame" id="preview-frame" sandbox="" title="Post preview"
                    referrerpolicy="no-referrer"></iframe>
          </section>
        </div>

        <section class="attachments" aria-labelledby="attachments-title">
          <div class="attachments-head">
            <h2 class="attachments-title" id="attachments-title">Attachments</h2>
            <button type="button" class="button button-secondary button-small" id="attach">Attach files</button>
            <input type="file" id="attach-input" multiple hidden
                   accept="image/png,image/jpeg,image/gif,image/webp,.tex" />
          </div>
          <p class="attachments-hint">PNG, JPEG, GIF or WebP up to 10 MiB, or a .tex snippet up to 256 KiB.
            You can also paste or drop images straight into the body.</p>
          <ul class="attachment-list" id="attachment-list"></ul>
          <div class="relink" id="relink-tools" hidden>
            <label class="field">
              <span class="field-label">Unresolved reference</span>
              <select id="unresolved-reference"></select>
            </label>
            <label class="field">
              <span class="field-label">Replace with</span>
              <select id="relink-attachment"></select>
            </label>
            <button type="button" class="button button-secondary button-small" id="relink">Relink</button>
          </div>
          <p class="attach-status" id="attach-status" role="status" aria-live="polite"></p>
        </section>

        <!-- Folders go straight to storage, file by file, on signed URLs; the
             server rehashes every byte before a bundle exists (§3.6). -->
        <section class="attachments interactives" aria-labelledby="interactives-title">
          <div class="attachments-head">
            <h2 class="attachments-title" id="interactives-title">Interactives</h2>
            <button type="button" class="button button-secondary button-small" id="attach-lab">Attach lab folder</button>
            <button type="button" class="button button-secondary button-small" id="attach-figure">Attach figure folder</button>
            <input type="file" id="interactive-input" webkitdirectory multiple hidden />
          </div>
          <p class="attachments-hint">A lab runs sealed in a frame from its <code>index.html</code>; a figure runs
            as page code from <code>main.mjs</code> exporting <code>mount(root, context)</code>. Both need a static
            <code>fallback.html</code>. An optional <code>interactive.json</code> sets <code>entry</code>,
            <code>fallback</code> and <code>dependencies</code> (distill, d3). Markdown posts only.</p>
          <ul class="attachment-list" id="interactive-list"></ul>
          <p class="attach-status" id="interactive-status" role="status" aria-live="polite"></p>
        </section>

        <!-- What readers see of this post, read back from the build manifest the
             site is serving (lib/server/deployments.mjs), never assumed from a
             publish having succeeded. -->
        <section class="publication" id="publication" aria-labelledby="publication-title" hidden>
          <div class="publication-head">
            <h2 class="publication-title" id="publication-title">On the site</h2>
            <span class="site-chip" id="publication-chip"></span>
          </div>
          <p class="publication-summary" id="publication-summary" role="status" aria-live="polite"></p>
          <div class="publication-actions">
            <label class="field">
              <span class="field-label">Stored revisions</span>
              <select id="publication-revision"></select>
            </label>
            <button type="button" class="button button-secondary button-small" id="publication-branch">Edit as draft</button>
            <button type="button" class="button button-secondary button-small" id="publication-rollback">Roll back to this revision</button>
            <button type="button" class="button button-danger button-small" id="publication-unpublish">Unpublish</button>
          </div>
        </section>

        <div class="editor-actions">
          <!-- What Publish would do, decided by publishing's own checks
               (action "check"). A description rather than a live region: it
               changes as the author types, and is heard when Publish has focus. -->
          <p class="publish-readiness" id="publish-readiness"></p>
          <button type="button" class="button" id="publish" aria-describedby="publish-readiness">Publish</button>
          <button type="button" class="button button-secondary" id="save">Save</button>
          <button type="button" class="button button-secondary" id="preview-toggle"
                  aria-pressed="false" aria-controls="preview-pane">Preview</button>
          <button type="button" class="button button-secondary" id="export">Export source</button>
          <button type="button" class="button button-danger" id="discard">Discard draft</button>
          <p class="editor-error" id="editor-error" role="alert" aria-live="assertive"></p>
          <p class="editor-published" id="editor-published" role="status" aria-live="polite"></p>
        </div>
      </section>
    </main>

    <!-- The choice is between the text on this screen and the text that is
         saved, not between older and newer. Unsaved text can easily be the more
         recent work, so the labels say what each button does rather than
         claiming which version is newer. -->
    <div class="conflict" id="conflict" hidden role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div class="conflict-card">
        <h2 id="conflict-title">This draft was saved somewhere else</h2>
        <p id="conflict-detail">Nothing has been overwritten yet.</p>
        <div class="conflict-actions">
          <button type="button" class="button" id="conflict-keep">Save mine over it</button>
          <button type="button" class="button button-secondary" id="conflict-theirs">Discard mine, load saved</button>
        </div>
        <p class="conflict-note" id="conflict-note"></p>
      </div>
    </div>`,
  });
}
