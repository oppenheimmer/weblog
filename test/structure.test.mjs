import test from "node:test";
import assert from "node:assert/strict";
import { structureArticle, tableOfContents, inspectHtml } from "../lib/structure.mjs";
import { normalizePost } from "../lib/content.mjs";
import { postPage, listPage } from "../lib/templates.mjs";

test("headings preserve existing ids and markup, deduplicate new ids and escape contents labels", () => {
  const input = '<h2 id="section-repeat">Existing</h2><h3>Repeat</h3><h3>Repeat</h3><pre>&lt;h2&gt;Code&lt;/h2&gt;</pre><h4>&lt;script&gt; &amp; math</h4>';
  const result = structureArticle(input);
  assert.deepEqual(result.headings.map((h) => h.id), ["section-repeat", "section-repeat-2", "section-repeat-3", "section-script-math"]);
  assert.ok(result.html.includes('<pre>&lt;h2&gt;Code&lt;/h2&gt;</pre>'));
  const toc = tableOfContents(result.headings);
  assert.ok(toc.includes('&lt;script&gt; &amp; math'));
  assert.ok(!toc.includes('<script>'));
  assert.equal(tableOfContents(result.headings.slice(0, 2)), "");
});

test("Markdown and LaTeX articles get stable contents links without adding contents to listings", () => {
  for (const [format, body] of [["markdown", "## First\n### Nested\n## Last"], ["latex", "\\section{First}\n\\subsection{Nested}\n\\section{Last}"]]) {
    const post = normalizePost({ data: { title: "Sections", date: "2026-10-29", slug: "sections" }, body, format });
    const page = postPage(post);
    assert.ok(page.includes('aria-label="On this page"'));
    const ids = inspectHtml(page).ids;
    for (const heading of post.headings) assert.ok(ids.has(heading.id));
    assert.ok(!listPage([post]).includes('aria-label="On this page"'));
  }
});
