// Configured markdown-it instance: build-time KaTeX math, code highlighting, heading anchors.
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import texmath from "markdown-it-texmath";
import katex from "katex";
import hljs from "highlight.js";

export const md = new MarkdownIt({
  html: true, // author-authored content; allow raw HTML when needed
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
    return `<pre class="code-block"><code class="hljs">${md.utils.escapeHtml(code)}</code></pre>`;
  },
});

// Heading anchors: stable slug ids + a clickable permalink for deep linking.
md.use(anchor, {
  level: [2, 3, 4],
  permalink: anchor.permalink.linkInsideHeader({
    symbol: "#",
    placement: "after",
    class: "heading-anchor",
    ariaHidden: true,
  }),
});

// Math rendered to HTML at build time via KaTeX. `$...$` inline, `$$...$$` display.
md.use(texmath, {
  engine: katex,
  delimiters: "dollars",
  katexOptions: { throwOnError: false, strict: false },
});

// External links open safely in a new tab while keeping in-site/anchor links normal.
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href") || "";
  if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

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
