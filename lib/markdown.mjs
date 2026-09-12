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

import { isSafeUrl, isLocalImageUrl, ENGINE, BROWSER } from "./sanitize.mjs";
import { INTERACTIVE_FENCE, readInteractivePayload } from "./interactives.mjs";
import { renderLatex } from "./latex.mjs";
import { slugify } from "./templates.mjs";
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

    // Images in a browser-authored post must be served by this site — after
    // publishing, /images/uploads/<slug>/<name>. A remote src would have every
    // reader's browser call a third party, so it renders as its alt text
    // instead. Links are unaffected: a link is followed by choice, an image is
    // fetched on sight.
    const defaultImage = instance.renderer.rules.image;
    instance.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (!isLocalImageUrl(token.attrGet("src"))) {
        return instance.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env));
      }
      return defaultImage(tokens, idx, options, env, self);
    };
  }

  // Heading anchors: stable slug ids + a clickable permalink for deep linking.
  //
  // `slugify` is the site's own, not markdown-it-anchor's default. Two reasons.
  // It collapses runs of separators, so a heading id can never contain "--",
  // which is what makes a collision with the page's chrome ids impossible
  // rather than merely unlikely (see `sprite()` in lib/templates.mjs). And it
  // avoids the default's percent-encoding, which turned an accented heading
  // into an unreadable fragment.
  //
  // The permalink is named rather than hidden. aria-hidden on a focusable link
  // is a contradiction: a screen-reader user tabs onto it and hears nothing.
  instance.use(anchor, {
    level: [2, 3, 4],
    slugify,
    // Built per heading, because renderAttrs is given only (slug, state) while
    // the heading's own text needs the token index. Naming each link after its
    // heading is what makes a list of links useful rather than twenty identical
    // "Permalink" entries. markdown-it escapes attribute values, so a heading
    // containing a quote cannot break out.
    permalink: (slug, opts, state, idx) => {
      const heading = state.tokens[idx + 1]?.content?.trim();
      return anchor.permalink.linkInsideHeader({
        symbol: "#",
        placement: "after",
        class: "heading-anchor",
        ariaHidden: false,
        renderAttrs: () => ({
          "aria-label": `Permalink to ${heading ? `“${heading}”` : "this section"}`,
        }),
      })(slug, opts, state, idx);
    },
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
      return `<div class="tex-snippet">${renderLatex(token.content, { trust: trusted ? ENGINE : BROWSER })}</div>\n`;
    }
    if (language === INTERACTIVE_FENCE) {
      return renderInteractive(token.content);
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
    // Maths, code and images are dropped rather than described, which strands
    // the punctuation that was written around them: "identity, $x$, ties"
    // became "identity, , ties" in the meta description, the social card and
    // the RSS summary. Repeated marks are collapsed, but "..." is left alone,
    // since an ellipsis is something an author wrote on purpose.
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?:\s*\1)+/g, "$1")
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

/**
 * What a resolved `::demo[<id>]` becomes on the page (CLAUDE.md §3.6).
 *
 * Static HTML carries the **fallback**, never the lab: the engine's own script
 * replaces it with a sandboxed iframe, and only on a post's own page. That one
 * decision buys three of §3.6's requirements at once — listings show the
 * fallback and execute nothing, a reader without JavaScript gets the fallback
 * rather than an empty box, and the iframe's attributes live in engine code
 * where a single tripwire can pin them, instead of being spread through stored
 * revisions that were frozen before the rules changed.
 *
 * A payload that does not read back as one a resolver wrote is dropped. The
 * renderer cannot tell this fence from one an author typed by hand, because a
 * post may legitimately contain three backticks.
 */
export function renderInteractive(content) {
  const payload = readInteractivePayload(content);
  if (!payload) {
    return '<div class="interactive interactive--broken"><p>This interactive could not be loaded.</p></div>\n';
  }
  const attr = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return (
    `<figure class="interactive" data-interactive="demo" ` +
    `data-interactive-src="${attr(payload.src)}" data-interactive-name="${attr(payload.name)}">` +
    `<div class="interactive-fallback">${payload.fallback}</div>` +
    `</figure>\n`
  );
}
