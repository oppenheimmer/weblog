// Attribute-level edits to HTML the renderer has already produced.
//
// The feed puts several complete posts on one page (CLAUDE.md Step 8), and a
// post rendered for its own page cannot simply be pasted beside another: two
// posts with an "## Introduction" both claim id="introduction", and every
// in-page link to the second one jumps into the first. The fix belongs after
// rendering rather than inside it, because ids come from more than one place —
// markdown-it-anchor, raw HTML in repository posts, whatever unified-latex grows
// next — and one pass over the output covers all of them.
//
// A tokenizer rather than a regular expression over the document, so only the
// attributes of real start tags are ever touched. Text that merely looks like
// an attribute passes through: `id="x"` in LaTeX prose, which the hast
// serializer leaves unescaped, is text. Everything not edited is copied byte for
// byte, so KaTeX output comes out exactly as it went in.

const WHITESPACE = /[\t\n\f\r ]/;
// Elements whose content the HTML parser reads as text up to the closing tag.
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

/** What a post slug looks like after slugify: the only safe id prefix. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseStartTag(source, lt) {
  const n = source.length;
  let i = lt + 1;
  while (i < n && !WHITESPACE.test(source[i]) && source[i] !== "/" && source[i] !== ">") i++;
  const name = source.slice(lt + 1, i).toLowerCase();
  const attrs = [];

  while (i < n) {
    while (i < n && (WHITESPACE.test(source[i]) || source[i] === "/")) i++;
    if (i >= n) return null;
    if (source[i] === ">") {
      // Where new attributes go: before a self-closing "/", unless that slash
      // belongs to an unquoted value running up to the ">".
      const last = attrs.at(-1);
      const slashIsValue = last && !last.quote && last.valueEnd === i;
      return { name, attrs, end: i + 1, close: source[i - 1] === "/" && !slashIsValue ? i - 1 : i };
    }

    const start = i++;
    while (i < n && !WHITESPACE.test(source[i]) && !"/>=".includes(source[i])) i++;
    const attr = { name: source.slice(start, i).toLowerCase(), nameEnd: i, value: null, quote: "", valueStart: -1, valueEnd: -1 };

    let j = i;
    while (j < n && WHITESPACE.test(source[j])) j++;
    if (source[j] !== "=") {
      attrs.push(attr);
      continue;
    }
    j++;
    while (j < n && WHITESPACE.test(source[j])) j++;
    if (j >= n) return null;

    if (source[j] === '"' || source[j] === "'") {
      const close = source.indexOf(source[j], j + 1);
      if (close === -1) return null;
      Object.assign(attr, { quote: source[j], valueStart: j + 1, valueEnd: close });
      i = close + 1;
    } else {
      let k = j;
      while (k < n && !WHITESPACE.test(source[k]) && source[k] !== ">") k++;
      Object.assign(attr, { valueStart: j, valueEnd: k });
      i = k;
    }
    attr.value = source.slice(attr.valueStart, attr.valueEnd);
    attrs.push(attr);
  }
  return null;
}

/**
 * Walk every start tag in `html` and let `visit` edit its attributes.
 *
 * `visit` receives `{ name, get, has, set }`. Values are raw attribute text, as
 * written in the source, and `set` writes raw text back: a caller adding a value
 * must supply one that needs no escaping, which is checked. Duplicate attributes
 * resolve to the first, as the HTML parser does. Returns the input unchanged
 * when nothing was edited.
 */
export function rewriteStartTags(html, visit) {
  const source = String(html);
  const lower = source.toLowerCase();
  const n = source.length;
  let out = "";
  let copied = 0;
  let i = 0;

  const skipTo = (marker, from) => {
    const end = source.indexOf(marker, from);
    return end === -1 ? n : end + marker.length;
  };

  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;
    const next = source[lt + 1] ?? "";

    if (source.startsWith("<!--", lt)) { i = skipTo("-->", lt + 4); continue; }
    // Anything else after "<!" — including "<![CDATA[", which is only CDATA
    // inside SVG or MathML — the HTML parser ends at the first ">".
    if (next === "!" || next === "?" || next === "/") { i = skipTo(">", lt + 2); continue; }
    if (!/[A-Za-z]/.test(next)) { i = lt + 1; continue; }

    const tag = parseStartTag(source, lt);
    if (!tag) { i = lt + 1; continue; }

    const edits = new Map();
    const added = [];
    const first = (name) => tag.attrs.find((a) => a.name === name);
    visit({
      name: tag.name,
      has: (name) => Boolean(first(name)) || added.some((a) => a.name === name),
      get: (name) => (edits.has(name) ? edits.get(name) : first(name)?.value ?? null),
      set(name, value) {
        const text = String(value);
        const existing = first(name);
        // A raw value is written back in the quoting its attribute already has,
        // so it must not be able to close that quoting early.
        const unsafe = existing?.quote
          ? text.includes(existing.quote)
          : existing?.valueStart > -1 ? text === "" || /["'=<>`\t\n\f\r ]/.test(text) : /["&<>]/.test(text);
        if (unsafe) throw new Error(`Refusing to write an unescaped value into ${name}.`);
        if (existing) edits.set(name, text);
        else if (!added.some((a) => a.name === name)) added.push({ name, value: text });
      },
    });

    if (edits.size || added.length) {
      out += source.slice(copied, lt);
      let cursor = lt;
      for (const attr of tag.attrs) {
        if (!edits.has(attr.name) || attr !== first(attr.name)) continue;
        if (attr.valueStart === -1) {
          // A bare attribute such as `<img loading>` gains a value.
          out += source.slice(cursor, attr.nameEnd) + `="${edits.get(attr.name)}"`;
          cursor = attr.nameEnd;
        } else {
          out += source.slice(cursor, attr.valueStart) + edits.get(attr.name);
          cursor = attr.valueEnd;
        }
      }
      out += source.slice(cursor, tag.close);
      out += added.map((a) => ` ${a.name}="${a.value}"`).join("");
      out += source.slice(tag.close, tag.end);
      copied = tag.end;
    }

    i = tag.end;
    if (RAW_TEXT.has(tag.name)) {
      const close = lower.indexOf(`</${tag.name}`, i);
      i = close === -1 ? n : close;
    }
  }
  return copied === 0 ? source : out + source.slice(copied);
}

/** Every id a fragment of HTML defines, as raw attribute text. */
export function definedIds(html) {
  const ids = new Set();
  rewriteStartTags(html, (tag) => {
    const id = tag.get("id");
    if (id) ids.add(id);
  });
  return ids;
}

// Attributes that name another element by id. Space-separated where ARIA allows a list.
const ID_REFERENCES = ["for", "form", "list", "headers", "aria-activedescendant", "aria-controls",
  "aria-describedby", "aria-details", "aria-errormessage", "aria-flowto", "aria-labelledby", "aria-owns",
  "popovertarget", "commandfor"];
const FRAGMENT_LINKS = ["href", "xlink:href"];
// SVG paint servers, clip paths, masks and markers, in attributes or inline style.
const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;

/**
 * Prepare one post's rendered body to sit beside others on a listing page.
 *
 *   idPrefix  every id the body defines becomes `<prefix>--<id>`, and every
 *             reference to one of those ids follows it. References to ids the
 *             body does not define — the page's own #main-content, say — are
 *             left alone.
 *   sizes     Map of image src -> { width, height }; matching images without
 *             dimensions get them, so the page does not jump as they load.
 *   lazy      images not yet told otherwise load when scrolled near.
 *   permalinks  `{ className, base }`: a link carrying that class and pointing
 *             at a heading in the body goes to `<base>#<original id>` instead,
 *             because a section link copied from a listing should outlive the
 *             listing. Page 3 of a feed is a different page after every post.
 *
 * The prefix must be a post slug. Slugs never contain "--" and never end in "-",
 * so the first "--" in a prefixed id always marks the end of the slug: two
 * posts cannot produce the same id, and none can equal an id in the page chrome,
 * which contains no "--".
 */
export function prepareArticle(html, { idPrefix = null, sizes = null, lazy = false, permalinks = null } = {}) {
  if (idPrefix !== null && !SLUG.test(idPrefix)) {
    throw new Error(`Not a usable id prefix: ${JSON.stringify(idPrefix)}`);
  }
  const ids = idPrefix ? definedIds(html) : new Set();
  const ns = (id) => `${idPrefix}--${id}`;
  const renameList = (value) => value.replace(/[^\t\n\f\r ]+/g, (token) => (ids.has(token) ? ns(token) : token));

  return rewriteStartTags(html, (tag) => {
    if (ids.size) {
      const id = tag.get("id");
      if (id && ids.has(id)) tag.set("id", ns(id));

      const href = tag.get("href");
      if (permalinks && tag.name === "a" && href?.startsWith("#") && ids.has(href.slice(1)) &&
          (tag.get("class") ?? "").split(/[\t\n\f\r ]+/).includes(permalinks.className)) {
        tag.set("href", `${permalinks.base}${href}`);
      }

      for (const name of FRAGMENT_LINKS) {
        const value = tag.get(name);
        if (value?.startsWith("#") && ids.has(value.slice(1))) tag.set(name, `#${ns(value.slice(1))}`);
      }
      for (const name of ID_REFERENCES) {
        const value = tag.get(name);
        if (value) {
          const renamed = renameList(value);
          if (renamed !== value) tag.set(name, renamed);
        }
      }
      for (const name of ["style", "fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"]) {
        const value = tag.get(name);
        if (value?.includes("url(")) {
          const renamed = value.replace(URL_REFERENCE, (whole, quote, id) =>
            ids.has(id) ? `url(${quote}#${ns(id)}${quote})` : whole);
          if (renamed !== value) tag.set(name, renamed);
        }
      }
    }

    if (tag.name !== "img") return;
    const size = sizes?.get(tag.get("src"));
    // Dimensions come from a manifest stored in R2, so they are checked here,
    // at the point they become markup, rather than trusted.
    const sane = (value) => Number.isInteger(value) && value > 0 && value <= 100_000;
    if (size && sane(size.width) && sane(size.height) && !tag.has("width") && !tag.has("height")) {
      tag.set("width", size.width);
      tag.set("height", size.height);
    }
    if (lazy && !tag.has("loading")) tag.set("loading", "lazy");
  });
}

/** True when the HTML contains a start tag for any of `names`. */
export function containsElement(html, names) {
  const wanted = new Set(names);
  let found = false;
  rewriteStartTags(html, (tag) => {
    if (wanted.has(tag.name)) found = true;
  });
  return found;
}
