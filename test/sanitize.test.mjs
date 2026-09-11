// Tier 4 — security regression.
//
// CLAUDE.md §3.1 put the editor on the same origin as every published post, and
// accepted that risk on the stated condition that browser-authored content can
// never carry script. These tests are that condition. Each one must stay
// red-if-broken forever: a failure here is an editor-session compromise, not a
// cosmetic defect.
//
// Every case below was confirmed to actually leak before the fix landed.
import test from "node:test";
import assert from "node:assert/strict";

import { md, mdBrowser, rendererFor } from "../lib/markdown.mjs";
import { renderLatex } from "../lib/latex.mjs";
import { isSafeUrl, ENGINE, BROWSER, DEFAULT_TRUST } from "../lib/sanitize.mjs";
import { normalizePost, loadPost } from "../lib/content.mjs";

/**
 * Flag only *live* markup.
 *
 * Deliberately not a search for the word "script": escaped text that merely
 * mentions a tag is correct output, and a detector that cannot tell the
 * difference reports false alarms and hides real ones.
 */
function liveMarkup(html) {
  const rules = [
    [/<\s*(script|iframe|object|embed|svg|form|base|meta|link|style)\b/i, "dangerous element"],
    [/<[a-z][^>]*\son[a-z]+\s*=/i, "event-handler attribute"],
    [/<[a-z][^>]*\s(?:href|src|action|formaction|data|poster)\s*=\s*["']?\s*(?:javascript|vbscript|data:text\/html)/i,
      "script-bearing URL"],
    [/<[a-z][^>]*\ssrcdoc\s*=/i, "srcdoc"],
  ];
  return rules.filter(([re]) => re.test(html)).map(([, name]) => name);
}

// Confirmed live against the renderer before the sanitizer existed.
const ATTACKS = [
  ["raw script tag", "<script>alert(1)</script>"],
  ["img onerror", '<img src=x onerror="alert(1)">'],
  ["iframe", '<iframe src="https://evil.test"></iframe>'],
  ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ["svg onload", "<svg onload=alert(1)>"],
  ["inline event handler", "`ok` <b onmouseover=alert(1)>hi</b>"],
  ["form with formaction", '<form><button formaction="javascript:alert(1)">go</button></form>'],
  ["base tag", '<base href="https://evil.test/">'],
  ["link stylesheet", '<link rel="stylesheet" href="https://evil.test/x.css">'],
  ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.test">'],
  ["style tag", "<style>body{display:none}</style>"],
  ["object", '<object data="javascript:alert(1)"></object>'],
  ["embed", '<embed src="javascript:alert(1)">'],
  ["comment cloak", "<!--><script>alert(1)</script>-->"],
  ["uppercase tag", "<SCRIPT>alert(1)</SCRIPT>"],
  ["nested angle brackets", "<<script>script>alert(1)<</script>/script>"],
  ["link javascript: url", "[click](javascript:alert(1))"],
  ["link tab-cloaked scheme", "[click](java\tscript:alert(1))"],
  ["image javascript: url", "![x](javascript:alert(1))"],
  ["image data:text/html", "![x](data:text/html;base64,PHNjcmlwdD4=)"],
  ["katex href macro", "$\\href{javascript:alert(1)}{click}$"],
];

// ------------------------------------------------------- the core guarantee

for (const [name, source] of ATTACKS) {
  test(`browser-authored markdown cannot emit live markup: ${name}`, () => {
    const html = mdBrowser.render(source);
    assert.deepEqual(liveMarkup(html), [], `leaked from: ${source}\nrendered: ${html}`);
  });
}

test("the whole attack corpus is inert through the post pipeline, not just the renderer", () => {
  for (const [name, source] of ATTACKS) {
    const post = normalizePost({
      data: { title: "T", date: "2026-01-01" },
      body: source,
      format: "markdown",
      sourceName: "hostile.md",
      trust: BROWSER,
    });
    assert.deepEqual(liveMarkup(post.html), [], `${name} survived normalizePost`);
  }
});

// ------------------------------------------------------------ fail-safe-ness

test("trust defaults to untrusted, so a caller that forgets is not thereby exposed", () => {
  assert.equal(DEFAULT_TRUST, BROWSER);

  // No trust argument at all.
  const post = normalizePost({
    data: { title: "T", date: "2026-01-01" },
    body: "<script>alert(1)</script>",
    format: "markdown",
    sourceName: "forgot.md",
  });
  assert.deepEqual(liveMarkup(post.html), [], "omitting trust produced the permissive renderer");

  const viaLoad = loadPost("---\ntitle: T\ndate: 2026-01-01\n---\n<script>alert(1)</script>", {
    sourceName: "forgot.md",
  });
  assert.deepEqual(liveMarkup(viaLoad.html), []);
});

test("an unrecognised trust value is untrusted, not trusted", () => {
  for (const trust of ["ENGINE", "trusted", "", null, undefined, true, {}]) {
    assert.equal(rendererFor(trust), mdBrowser, `${JSON.stringify(trust)} selected the trusted renderer`);
  }
  assert.equal(rendererFor(ENGINE), md);
});

test("browser content can never set the per-post script hooks", () => {
  // publish.mjs drops these when writing a revision; this is the second lock,
  // and the one that holds if some future path forgets the first.
  const post = normalizePost({
    data: {
      title: "T", date: "2026-01-01",
      styles: ["/evil.css"], scripts: ["/evil.js"], head: "<script>alert(1)</script>", distill: true,
    },
    body: "Body.",
    format: "markdown",
    sourceName: "hooks.md",
    trust: BROWSER,
  });
  assert.deepEqual(post.styles, []);
  assert.deepEqual(post.scripts, []);
  assert.equal(post.head, "");
  assert.equal(post.distill, false);
});

// -------------------------------------------------- the trusted path survives

test("repository-authored posts keep raw HTML and their embed hooks", () => {
  // The sanitizer must be path-dependent. If the trusted path lost raw HTML,
  // existing posts and the Distill bundle would break silently.
  const html = md.render('<div class="figure">kept</div>');
  assert.match(html, /<div class="figure">kept<\/div>/);

  const post = normalizePost({
    data: {
      title: "T", date: "2026-01-01",
      styles: ["/a.css"], scripts: ["/a.js"], head: "<meta name=x>", distill: true,
    },
    body: '<div class="figure">kept</div>',
    format: "markdown",
    sourceName: "trusted.md",
    trust: ENGINE,
  });
  assert.deepEqual(post.scripts, ["/a.js"]);
  assert.equal(post.distill, true);
  assert.match(post.html, /<div class="figure">/);
});

// --------------------------------------------------------------- math is safe

test("sanitizing does not break maths, which is how sanitizers usually fail", () => {
  for (const renderer of [md, mdBrowser]) {
    const html = renderer.render("Inline $E = mc^2$ and display:\n\n$$\\int_0^1 x\\,dx$$");
    assert.match(html, /class="katex/, "KaTeX output was lost");
    assert.match(html, /<math/, "MathML was stripped");
    assert.deepEqual(liveMarkup(html), [], "KaTeX output tripped the detector");
  }
});

test("code blocks and highlighting survive on both paths", () => {
  for (const renderer of [md, mdBrowser]) {
    const html = renderer.render("```js\nconst x = 1;\n```");
    assert.match(html, /class="hljs/);
  }
  // Code *content* that looks like an attack stays escaped, not executed.
  const html = mdBrowser.render("```html\n<script>alert(1)</script>\n```");
  assert.deepEqual(liveMarkup(html), []);
});

test("ordinary links and images still work on the untrusted path", () => {
  const html = mdBrowser.render(
    "[ext](https://example.com) [rel](/images/uploads/a/b.png) [frag](#x) ![alt](/images/x.png)"
  );
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /href="\/images\/uploads\/a\/b\.png"/);
  assert.match(html, /href="#x"/);
  assert.match(html, /<img src="\/images\/x\.png"/);
});

// ----------------------------------------------------------------- URL policy

test("isSafeUrl blocks script-bearing schemes including cloaked spellings", () => {
  for (const bad of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "  javascript:alert(1)",
    "java\tscript:alert(1)", "java\nscript:alert(1)", "java\rscript:alert(1)",
    "\u0000javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html,<script>",
    "file:///etc/passwd", "", null, undefined,
  ]) {
    assert.equal(isSafeUrl(bad), false, `allowed: ${JSON.stringify(bad)}`);
  }
});

test("isSafeUrl allows the schemes a blog actually needs", () => {
  for (const good of [
    "https://example.com", "http://example.com", "mailto:a@b.test",
    "/images/uploads/post/x.png", "#section", "?view=table", "relative/path.png",
  ]) {
    assert.equal(isSafeUrl(good), true, `blocked: ${JSON.stringify(good)}`);
  }
});

// --------------------------------------------------------------- LaTeX path

test("LaTeX URL macros cannot emit a script URL, on either trust level", () => {
  // unified-latex builds a live <a href> without checking the scheme, so this
  // leaked regardless of the raw-HTML setting. The .tex sanitizer is therefore
  // unconditional, and these assertions carry no trust argument.
  for (const source of [
    "\\href{javascript:alert(1)}{click}",
    "\\url{javascript:alert(1)}",
    "\\href{VBScript:msgbox(1)}{click}",
    "\\href{data:text/html,<script>alert(1)</script>}{click}",
    "\\href{  javascript:alert(1)}{click}",
  ]) {
    const html = renderLatex(source);
    assert.deepEqual(liveMarkup(html), [], `leaked from: ${source}\nrendered: ${html}`);
    assert.ok(!/href="\s*javascript/i.test(html), `javascript: survived in ${source}`);
  }
});

test("legitimate LaTeX links and structure still render", () => {
  const html = renderLatex("\\href{https://example.com}{click}\n\n\\section{Hi}\n\nText.");
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /Hi/);
  assert.match(html, /Text\./);
});

test("LaTeX maths survives the sanitizer", () => {
  const html = renderLatex("Inline $E = mc^2$ and \\[ \\int_0^1 x\\,dx \\]");
  assert.match(html, /class="katex/);
  assert.deepEqual(liveMarkup(html), []);
});

test("raw HTML in a .tex source stays escaped", () => {
  const html = renderLatex("<script>alert(1)</script>");
  assert.deepEqual(liveMarkup(html), []);
});

// --------------------------------------------------------------- metadata

test("hostile metadata cannot break out of the page, feed or JSON-LD", () => {
  // Complements the existing JSON-LD tripwire: these fields are now
  // browser-authored, so the escaping matters far more than it used to.
  const post = normalizePost({
    data: {
      title: '</script><img src=x onerror=alert(1)>',
      date: "2026-01-01",
      description: '"><script>alert(1)</script>',
      tags: ['<script>alert(1)</script>'],
      slug: "hostile-metadata",
    },
    body: "Body.",
    format: "markdown",
    sourceName: "meta.md",
    trust: BROWSER,
  });
  // normalizePost keeps metadata verbatim; the templates escape it. Assert the
  // values survive intact so the escaping happens in exactly one place.
  assert.equal(post.title, '</script><img src=x onerror=alert(1)>');
  assert.deepEqual(liveMarkup(post.html), []);
});

// ------------------------------------------- the tree filter, on its own terms
//
// Added after mutation testing: deleting the event-handler strip broke nothing,
// because no LaTeX macro can produce an `onclick` and the filter was only ever
// reached through unified-latex. A guard with no reachable test is a guard that
// rots silently, so `rehypeSafeHtml` is exercised here as the general-purpose
// tree sanitizer it is, independently of who happens to feed it today.

import { rehypeSafeHtml } from "../lib/sanitize.mjs";

const element = (tagName, properties = {}, children = []) => ({
  type: "element", tagName, properties, children,
});
const text = (value) => ({ type: "text", value });
const clean = (children) => {
  const tree = { type: "root", children };
  rehypeSafeHtml()(tree);
  return tree.children;
};

test("the tree filter strips event handlers in every spelling", () => {
  for (const name of ["onclick", "onClick", "ONERROR", "onmouseover", "onLoad"]) {
    const [node] = clean([element("img", { src: "/a.png", [name]: "alert(1)" })]);
    assert.deepEqual(Object.keys(node.properties), ["src"], `${name} survived`);
  }
});

test("the tree filter strips srcdoc, which smuggles a document past a src check", () => {
  const [node] = clean([element("div", { srcdoc: "<script>alert(1)</script>", id: "x" })]);
  assert.deepEqual(Object.keys(node.properties), ["id"]);
});

test("the tree filter removes unsafe URLs but keeps the element and its text", () => {
  const [node] = clean([element("a", { href: "javascript:alert(1)", className: ["href"] },
    [text("click")])]);
  assert.equal(node.tagName, "a");
  assert.equal(node.properties.href, undefined, "the script URL survived");
  assert.deepEqual(node.properties.className, ["href"]);
  assert.equal(node.children[0].value, "click", "the link text was destroyed with the URL");
});

test("the tree filter checks every URL-bearing attribute, not just href", () => {
  for (const attribute of ["href", "src", "action", "formAction", "poster", "cite", "ping"]) {
    const [node] = clean([element("div", { [attribute]: "javascript:alert(1)" })]);
    assert.equal(node.properties[attribute], undefined, `${attribute} was not checked`);
  }
});

test("the tree filter drops executable elements together with their contents", () => {
  for (const tag of ["script", "style", "iframe", "object", "embed", "form", "base", "meta", "link"]) {
    assert.deepEqual(clean([element(tag, {}, [text("payload")])]), [], `${tag} survived`);
  }
});

test("an unrecognised element is unwrapped, so words are never silently lost", () => {
  // Degrading to plain content is the safe failure: a construct unified-latex
  // grows in a future version must not vanish, and must not go live either.
  const out = clean([element("marquee", {}, [text("important text")])]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "text");
  assert.equal(out[0].value, "important text");
});

test("the tree filter recurses, so a handler cannot hide inside a safe element", () => {
  const [outer] = clean([
    element("div", {}, [element("p", {}, [element("img", { src: "/a.png", onerror: "alert(1)" })])]),
  ]);
  const img = outer.children[0].children[0];
  assert.deepEqual(Object.keys(img.properties), ["src"], "a nested handler survived");
});

test("safe attributes and ordinary structure pass through untouched", () => {
  const [node] = clean([element("a", { href: "https://example.com", className: ["x"], id: "y" },
    [text("ok")])]);
  assert.equal(node.properties.href, "https://example.com");
  assert.deepEqual(node.properties.className, ["x"]);
  assert.equal(node.properties.id, "y");
});
