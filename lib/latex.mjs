// LaTeX (.tex) -> HTML via the pure-JS unified-latex pipeline.
// Math is rendered with the same build-time KaTeX engine used for Markdown, so
// `.tex` posts carry the `katex` class and reuse the per-page KaTeX-CSS gating.
import { unified } from "unified";
import { unifiedLatexFromString } from "@unified-latex/unified-latex-util-parse";
import { unifiedLatexToHast } from "@unified-latex/unified-latex-to-hast";
import rehypeStringify from "rehype-stringify";
import katex from "katex";

import { rehypeSafeHtml } from "./sanitize.mjs";

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
const processor = unified()
  .use(unifiedLatexFromString)
  .use(unifiedLatexToHast)
  .use(rehypeSafeHtml)
  .use(rehypeStringify);

// rehype-stringify HTML-escapes the math payload; KaTeX needs the raw source.
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&"); // last, so we don't double-decode
}

function renderMath(html) {
  return html
    .replace(/<div class="display-math">([\s\S]*?)<\/div>/g, (_, tex) =>
      katex.renderToString(decodeEntities(tex), {
        displayMode: true,
        throwOnError: false,
        strict: false,
      })
    )
    .replace(/<span class="inline-math">([\s\S]*?)<\/span>/g, (_, tex) =>
      katex.renderToString(decodeEntities(tex), {
        displayMode: false,
        throwOnError: false,
        strict: false,
      })
    );
}

export function renderLatex(tex) {
  const html = String(processor.processSync(tex));
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
