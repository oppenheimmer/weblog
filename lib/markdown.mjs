// Configured markdown-it instances: build-time KaTeX math, code highlighting, heading anchors.
//
// Two instances, differing in exactly one setting that matters — `html`.
// Repository-authored posts may embed raw HTML and legitimately do; posts that
// arrived from a browser may not, and for those markdown-it *escapes* raw
// markup rather than emitting it. See lib/sanitize.mjs for why that is stronger
// than filtering the output afterwards.
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import texmath from "markdown-it-texmath";
import katex from "katex";
import hljs from "highlight.js";

import { isSafeUrl, ENGINE } from "./sanitize.mjs";
import { renderLatex } from "./latex.mjs";
import { TEX_FENCE } from "./attachments.mjs";

function createRenderer({ trusted }) {
  const instance = new MarkdownIt({
    // Raw HTML passthrough is the entire markdown attack surface: every leak
    // found while building this (script, iframe, svg onload, onmouseover, base,
    // link rel=stylesheet) came through here and nothing else did.
    html: trusted,
    linkify: true,
    typographer: true,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          const out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          return `<pre class="code-block"><code class="hljs language-${lang}">${out}</code></pre>`;
        } catch {
          /* fall through to default escaping */
        }
      }
      return `<pre class="code-block"><code class="hljs">${instance.utils.escapeHtml(code)}</code></pre>`;
    },
  });

  // markdown-it already refuses javascript:, vbscript: and file: URLs. For
  // untrusted content narrow it further to an explicit allowlist, so the policy
  // is ours and stated in one place rather than inherited and assumed.
  if (!trusted) {
    instance.validateLink = isSafeUrl;
  }

  // Heading anchors: stable slug ids + a clickable permalink for deep linking.
  instance.use(anchor, {
    level: [2, 3, 4],
    permalink: anchor.permalink.linkInsideHeader({
      symbol: "#",
      placement: "after",
      class: "heading-anchor",
      ariaHidden: true,
    }),
  });

  // Math rendered to HTML at build time via KaTeX. `$...$` inline, `$$...$$` display.
  instance.use(texmath, {
    engine: katex,
    delimiters: "dollars",
    katexOptions: {
      throwOnError: false,
      strict: false,
      // Explicit even though it is the default: `trust` enables \href, \url and
      // the \html* family, which would reopen the hole this file closes. Stating
      // it means a future edit has to argue with a comment rather than a silence.
      trust: false,
    },
  });

  // A `.tex` snippet attached to a Markdown post arrives as a fenced block (see
  // lib/attachments.mjs). It is rendered here rather than inlined as HTML at
  // publish time, which keeps browser-authored Markdown free of raw HTML and
  // routes the snippet through the LaTeX pipeline, where the unconditional
  // sanitizer applies. A `fence` rule rather than `highlight`, because
  // markdown-it re-wraps any highlight result that does not start with <pre.
  const defaultFence = instance.renderer.rules.fence;
  instance.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const language = token.info.trim().split(/\s+/)[0];
    if (language === TEX_FENCE) {
      return `<div class="tex-snippet">${renderLatex(token.content)}</div>\n`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  // External links open safely in a new tab while keeping in-site/anchor links normal.
  const defaultLinkOpen =
    instance.renderer.rules.link_open ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  instance.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet("href") || "";
    if (/^https?:\/\//i.test(href)) {
      tokens[idx].attrSet("target", "_blank");
      tokens[idx].attrSet("rel", "noopener noreferrer");
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return instance;
}

/** Repository-authored content. Raw HTML permitted; see CLAUDE.md §3.1. */
export const md = createRenderer({ trusted: true });

/** Anything that arrived from a browser or from R2. Raw HTML escaped, not rendered. */
export const mdBrowser = createRenderer({ trusted: false });

/** Pick a renderer by trust level. The safe one is the default everywhere. */
export function rendererFor(trust) {
  return trust === ENGINE ? md : mdBrowser;
}

// Detect whether a rendered post actually contains math (to gate KaTeX CSS per page).
// Match KaTeX's own output markup rather than the bare word: a post that merely
// discusses katex in prose must not pull in the stylesheet.
export function hasMath(html) {
  return /class="katex/.test(html);
}

// Strip HTML/markup to plain text for reading-time + meta descriptions.
export function toPlainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~`-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words-per-minute estimate from already-plain text (shared by .md and .tex).
export function readingTimeFromText(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

export function readingTime(markdown) {
  return readingTimeFromText(toPlainText(markdown));
}
