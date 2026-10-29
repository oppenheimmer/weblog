// Parse renderer output for navigation without reserializing KaTeX or article bytes.
import parse5 from "parse5";

const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inert = new Set(["script", "style", "template", "textarea", "annotation"]);
const textOf = (node) => {
  if (inert.has(node.tagName) || attr(node, "aria-hidden") === "true") return "";
  if (node.nodeName === "#text") return node.value;
  return (node.childNodes ?? []).map(textOf).join("");
};

export function inspectHtml(html, { locations = false } = {}) {
  const root = parse5.parseFragment(String(html), { sourceCodeLocationInfo: locations });
  const ids = new Set(), links = [], headings = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (inert.has(node.tagName)) continue;
    const id = attr(node, "id");
    if (id) ids.add(id);
    if (node.tagName === "a" && attr(node, "href") != null) links.push(attr(node, "href"));
    if (/^h[2-6]$/.test(node.tagName)) headings.push({
      id, level: Number(node.tagName[1]), text: textOf(node).replace(/\s+/g, " ").trim(),
      insert: node.sourceCodeLocation?.startTag?.endOffset,
    });
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return { ids, links, headings };
}

export function structureArticle(html) {
  const { ids, headings } = inspectHtml(html, { locations: true });
  const edits = [];
  for (const heading of headings) {
    if (!heading.id && heading.insert) {
      const base = "section-" + (heading.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "heading");
      let id = base, suffix = 2;
      while (ids.has(id)) id = `${base}-${suffix++}`;
      ids.add(id); heading.id = id;
      edits.push({ at: heading.insert - 1, text: ` id="${id}"` });
    }
  }
  let output = html;
  for (const edit of edits.reverse()) output = output.slice(0, edit.at) + edit.text + output.slice(edit.at);
  return { html: output, headings: headings.filter((h) => h.id && h.text).map(({ id, level, text }) => ({ id, level, text })) };
}

export function tableOfContents(headings = []) {
  if (headings.length < 3) return "";
  const roots = [], stack = [];
  for (const heading of headings) {
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    const node = { ...heading, children: [] };
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  const list = (nodes) => `<ol>${nodes.map((h) => `<li><a href="#${escape(encodeURIComponent(h.id))}">${escape(h.text)}</a>${h.children.length ? list(h.children) : ""}</li>`).join("")}</ol>`;
  return `<nav class="article-toc" aria-label="On this page"><h2>On this page</h2>${list(roots)}</nav>`;
}
