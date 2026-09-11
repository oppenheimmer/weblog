// LaTeX (.tex) -> HTML via the pure-JS unified-latex pipeline.
// Math is rendered with the same build-time KaTeX engine used for Markdown, so
// `.tex` posts carry the `katex` class and reuse the per-page KaTeX-CSS gating.
import { unified } from "unified";
import { unifiedLatexFromString } from "@unified-latex/unified-latex-util-parse";
import { unifiedLatexToHast } from "@unified-latex/unified-latex-to-hast";
import rehypeStringify from "rehype-stringify";
import katex from "katex";

import { rehypeSafeHtml, isTrusted, DEFAULT_TRUST } from "./sanitize.mjs";

// unified-latex emits math as *unrendered* LaTeX wrapped in
// <span class="inline-math">…</span> / <div class="display-math">…</div>.
// We post-process those through KaTeX (below).
//
// The sanitizer runs unconditionally, on trusted and untrusted .tex alike.
// unified-latex emits a live <a href> for \href{...} and \url{...} without
// checking the scheme, so \href{javascript:alert(1)}{click} produces a working
// script URL no matter who wrote the file — and no legitimate .tex needs one.
// Raw HTML in .tex source is already escaped by the parser, so unlike Markdown
// there is no trusted passthrough to preserve here.
//
// What trust does change is images. Repository-authored .tex may point
// \includegraphics anywhere; browser-authored .tex may only show images this
// site serves, so a post cannot turn into a third-party tracking pixel.
const processors = new Map();

function processorFor(trusted) {
  if (!processors.has(trusted)) {
    processors.set(trusted, unified()
      .use(unifiedLatexFromString)
      .use(unifiedLatexToHast)
      .use(rehypeSafeHtml, { allowRemoteImages: trusted })
      .use(rehypeStringify));
  }
  return processors.get(trusted);
}

// rehype-stringify HTML-escapes the math payload; KaTeX needs the raw source.
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&"); // last, so we don't double-decode
}

// `trust: false` is KaTeX's default; stated so an edit has to argue with it.
const KATEX_OPTIONS = { throwOnError: false, strict: false, trust: false };

function renderMath(html) {
  return html
    .replace(/<div class="display-math">([\s\S]*?)<\/div>/g, (_, tex) =>
      katex.renderToString(decodeEntities(tex), { ...KATEX_OPTIONS, displayMode: true })
    )
    .replace(/<span class="inline-math">([\s\S]*?)<\/span>/g, (_, tex) =>
      katex.renderToString(decodeEntities(tex), { ...KATEX_OPTIONS, displayMode: false })
    );
}

/** Render LaTeX. Untrusted unless the caller says otherwise, like everything else. */
export function renderLatex(tex, { trust = DEFAULT_TRUST } = {}) {
  const html = String(processorFor(isTrusted(trust)).processSync(tex));
  return renderMath(html);
}

// Plain text from rendered HTML, for reading-time on .tex posts.
export function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
