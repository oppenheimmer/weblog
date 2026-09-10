// Server-rendered HTML for the login and editor pages (CLAUDE.md §3.1, Step 5).
//
// These are functions, never static files: the editor markup must not be
// reachable without a session, and a file in dist/ would be.
//
// Both pages reuse the public stylesheet for design parity and add their own on
// top, so the editor looks like the blog rather than like a control panel.
import { escapeHtml, SITE } from "../templates.mjs";

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

/** Headers every editor page sends. */
export function pageHeaders() {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": EDITOR_CSP,
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
        <span class="editor-tag">Editor</span>
      </div>
      <div class="editor-bar-right">
        <span class="save-state" id="save-state" role="status" aria-live="polite"></span>
        <button type="button" class="button button-secondary" id="new-post">New post</button>
        <button type="button" class="button button-secondary" id="logout">Sign out</button>
      </div>
    </header>

    <main class="editor-layout">
      <aside class="editor-sidebar" aria-label="Drafts">
        <h2 class="sidebar-title">Drafts</h2>
        <ul class="draft-list" id="draft-list"></ul>
        <p class="sidebar-empty" id="draft-empty" hidden>No drafts yet.</p>
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

        <label class="field field-body">
          <span class="field-label">Body</span>
          <textarea id="body" spellcheck="true" aria-describedby="editor-error"></textarea>
        </label>

        <div class="editor-actions">
          <button type="button" class="button" id="save">Save</button>
          <button type="button" class="button button-secondary" id="export">Export source</button>
          <button type="button" class="button button-danger" id="discard">Discard draft</button>
          <p class="editor-error" id="editor-error" role="alert" aria-live="assertive"></p>
        </div>
      </section>
    </main>

    <div class="conflict" id="conflict" hidden role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div class="conflict-card">
        <h2 id="conflict-title">This draft changed elsewhere</h2>
        <p>Another tab or window saved since this one loaded. Nothing has been overwritten.</p>
        <div class="conflict-actions">
          <button type="button" class="button" id="conflict-keep">Keep my version</button>
          <button type="button" class="button button-secondary" id="conflict-theirs">Load the newer one</button>
        </div>
        <p class="conflict-note">
          "Keep my version" saves over the newer draft. "Load the newer one" discards
          the text currently on screen — export it first if you need it.
        </p>
      </div>
    </div>`,
  });
}
