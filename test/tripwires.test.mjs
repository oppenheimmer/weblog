// Named breaking-change tripwires (PLAN.md §5A).
//
// One test per defect confirmed against the source during the §0 review. Each
// exists so the behavior can never silently regress. They are named for the
// behavior they protect, not for the bug that prompted them.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildFixtures, cleanup, FIXTURES, ROOT } from "./helpers/build-fixture.mjs";
import { toPlainText } from "../lib/markdown.mjs";

const defect = (name) => path.join(FIXTURES, "defects", name, "posts");

/** Extract the JSON-LD payload the way an HTML parser would: to the first `</script>`. */
function extractJsonLd(html) {
  const open = '<script type="application/ld+json">';
  const start = html.indexOf(open);
  assert.notEqual(start, -1, "no JSON-LD block found");
  const from = start + open.length;
  return html.slice(from, html.indexOf("</script>", from));
}

test("tripwire: JSON-LD survives a title containing a script-closing sequence", () => {
  const dist = buildFixtures({ postsDir: defect("jsonld") });
  try {
    const html = fs.readFileSync(path.join(dist, "hostile-title", "index.html"), "utf8");
    const payload = extractJsonLd(html);
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(payload); },
      "JSON-LD payload was truncated by an unescaped </script> in post metadata"
    );
    assert.ok(parsed.headline.includes("</script>"), "headline lost its literal text");
    // The raw sequence must not appear unescaped inside the script element.
    assert.ok(
      !payload.includes("</script"),
      "an unescaped </script> inside JSON-LD lets post metadata break out of the script element"
    );
  } finally {
    cleanup(dist);
  }
});

test("tripwire: colliding slugs fail the build instead of silently overwriting", () => {
  assert.throws(
    () => execFileSync(process.execPath, [path.join(ROOT, "build.mjs")], {
      cwd: ROOT,
      env: {
        ...process.env,
        BLOG_POSTS_DIR: defect("slug-collision"),
        BLOG_ASSETS_DIR: path.join(FIXTURES, "assets"),
        BLOG_DIST_DIR: fs.mkdtempSync(path.join(ROOT, "node_modules", ".tmp-collide-")),
      },
      stdio: "pipe",
    }),
    /duplicate slug|slug collision/i,
    "two posts reducing to the same slug must abort the build, not overwrite one another"
  );
});

test("tripwire: post dates render identically regardless of server timezone", () => {
  const script = `
    import { formatDate } from ${JSON.stringify(path.join(ROOT, "lib", "templates.mjs"))};
    process.stdout.write(formatDate("2026-06-25T00:00:00.000Z"));
  `;
  const run = (tz) => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: tz }, encoding: "utf8",
  });
  const utc = run("UTC");
  for (const tz of ["America/Los_Angeles", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati"]) {
    assert.equal(run(tz), utc, `date shifted in ${tz}: a date-only post must not drift across timezones`);
  }
  assert.match(utc, /June 25, 2026/);
});

test("tripwire: KaTeX stylesheet is gated on real math, not on the word 'katex'", () => {
  const dist = buildFixtures({ postsDir: defect("math-gating") });
  try {
    const html = fs.readFileSync(path.join(dist, "prose-about-katex", "index.html"), "utf8");
    assert.ok(
      !html.includes("/styles/katex.min.css"),
      "a post that merely mentions katex in prose is loading the KaTeX stylesheet"
    );
  } finally {
    cleanup(dist);
  }
});

/**
 * Every rule that hides `.fade-up`, with the at-rules enclosing it.
 * Hand-rolled rather than pulling in a CSS parser: the site has no build step
 * for CSS and this only needs to understand nesting and selectors.
 */
function hidingRules(css, atRules = []) {
  const found = [];
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace === -1) break;
    const prelude = css.slice(i, brace).trim().replace(/\s+/g, " ");
    let depth = 1, j = brace + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const body = css.slice(brace + 1, j - 1);
    if (prelude.startsWith("@")) {
      found.push(...hidingRules(body, [...atRules, prelude]));
    } else if (/\.fade-up/.test(prelude) && /opacity:\s*0(\s|;|$)/.test(body)) {
      found.push({ selector: prelude, atRules });
    }
    i = j;
  }
  return found;
}

test("tripwire: listing content is visible without JavaScript and under reduced motion", () => {
  const raw = fs.readFileSync(path.join(ROOT, "assets", "styles", "blog.css"), "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, ""); // comments may mention selectors

  const suppressesAnimation =
    /@media[^{]*prefers-reduced-motion[^{]*\{[\s\S]*?animation:\s*none\s*!important/.test(css);
  const rules = hidingRules(css);

  // Guard against this test quietly becoming vacuous if the scanner stops
  // matching: the reveal exists, so the scanner must find the rule that drives it.
  if (/\.fade-up/.test(css) && /opacity:\s*0/.test(css)) {
    assert.ok(rules.length > 0, "scanner found no .fade-up hiding rule, but the CSS still has one");
  }

  for (const { selector, atRules } of rules) {
    // If the reveal animation is disabled under reduced motion, then any rule
    // that starts content hidden must not apply to those visitors.
    if (suppressesAnimation) {
      assert.ok(
        atRules.some((a) => /prefers-reduced-motion\s*:\s*no-preference/.test(a)),
        `"${selector}" hides content but is not guarded by prefers-reduced-motion: no-preference, ` +
        `while reduced motion disables the animation that would reveal it — those visitors get a blank page`
      );
    }
    // The hidden state is undone by script; without script it must never apply.
    assert.match(
      selector, /\.js\b/,
      `"${selector}" hides content unconditionally; with JavaScript disabled nothing ever reveals it`
    );
  }
});

/** Does `css` set `display` to something other than none for `selector`? */
function setsDisplay(css, selector) {
  const pattern = new RegExp(
    `(^|,|\\})\\s*[^{}]*\\${selector}[^{},]*\\{[^}]*display\\s*:\\s*(?!none)[a-z-]+`,
    "m"
  );
  return pattern.test(css);
}

/** Is there a rule that hides `selector` when it carries the hidden attribute? */
function neutralizesHidden(css, selector) {
  if (/\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/.test(css)) return true;
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\[hidden\\][^{]*\\{[^}]*display\\s*:\\s*none`).test(css);
}

test("tripwire: elements toggled with el.hidden actually hide", () => {
  // The `hidden` attribute hides only through the UA stylesheet, so any
  // author-level `display` on the same element wins and it never goes away.
  // This shipped once: the editor's conflict dialog set `display: grid`, so it
  // covered the page permanently and `el.hidden = true` could not dismiss it,
  // which made its own buttons look broken.
  //
  // Either fix is fine — a global backstop, or a targeted `sel[hidden]` rule.
  // What must not happen is a display rule with neither.
  const strip = (file) =>
    fs.readFileSync(path.join(ROOT, "assets", "styles", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");

  const toggled = [
    // blog.js toggles these on the public site.
    ["blog.css", ".mobile-menu"],
    ["blog.css", ".menu-icon"],
    // editor.js toggles these.
    ["editor.css", ".conflict"],
    ["editor.css", ".sidebar-empty"],
  ];

  for (const [file, selector] of toggled) {
    const css = strip(file);
    if (!setsDisplay(css, selector)) continue; // no display rule, so hidden works
    assert.ok(
      neutralizesHidden(css, selector),
      `${file}: "${selector}" sets display but nothing neutralizes it when the ` +
      `hidden attribute is present, so el.hidden = true will not hide it`
    );
  }
});

test("tripwire: dynamic api routes survive the trailing slash", () => {
  // vercel.json sets trailingSlash, so every request arrives as /a/b/. A bare
  // api/x/[id].js does not match a path ending in a slash and Vercel returns
  // its own 404 — which is how the draft item route silently never worked.
  // Nested as [id]/index.js it matches, mirroring dist/<slug>/index.html.
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  if (!vercel.trailingSlash) return; // rule only applies while that is on

  const offenders = [];
  (function walk(dir, rel = "") {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(next, `${rel}/${entry.name}`);
      else if (/^\[.+\]\.(js|mjs)$/.test(entry.name)) offenders.push(`api${rel}/${entry.name}`);
    }
  })(path.join(ROOT, "api"));

  assert.deepEqual(
    offenders, [],
    `these dynamic routes are leaf files and will 404 under trailingSlash; ` +
    `move each to <param>/index.js:\n  ${offenders.join("\n  ")}`
  );
});

test("tripwire: the repository is an engine and holds no content", () => {
  // CLAUDE.md §1.1: cloning gives the framework and nothing to read. Content
  // and media live in R2. test/ is fixtures, assets/ is design, not data.
  const offenders = [];
  const skip = new Set(["node_modules", ".git", "dist", "test", ".vercel"]);

  (function walk(dir, rel = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const next = path.join(dir, entry.name);
      const relPath = `${rel}/${entry.name}`.replace(/^\//, "");
      if (entry.isDirectory()) { walk(next, relPath); continue; }
      // A post is a .md/.tex file carrying frontmatter. README and CLAUDE are
      // documentation and have none.
      if (/\.(md|tex)$/.test(entry.name)) {
        const head = fs.readFileSync(next, "utf8").slice(0, 4);
        if (head.startsWith("---")) offenders.push(`${relPath} (post)`);
      }
      if (/\.(png|jpe?g|gif|webp|avif)$/i.test(entry.name)) offenders.push(`${relPath} (media)`);
    }
  })(ROOT);

  assert.deepEqual(
    offenders, [],
    `content found in the engine; it belongs in R2 (§1.1):\n  ${offenders.join("\n  ")}`
  );
});

test("tripwire: the post listing exposes a well-formed table to assistive tech", () => {
  // This was once an ARIA table built from divs, and the tag column fell out of
  // the accessibility tree because one branch forgot role="cell". A native
  // table cannot drop a column that way; what it can lose is the headers that
  // tie each cell to its column and row.
  const dist = buildFixtures();
  try {
    const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    const table = html.match(/<table class="post-table">([\s\S]*?)<\/table>/);
    assert.ok(table, "the listing has no native table");
    assert.equal((table[1].match(/<th scope="col">/g) ?? []).length, 3, "column headers are missing their scope");
    const rows = [...table[1].matchAll(/<tr>\s*<th scope="row"[^>]*>[\s\S]*?<\/tr>/g)];
    const bodyRows = (table[1].split("<tbody>")[1].match(/<tr>/g) ?? []).length;
    assert.ok(bodyRows > 0, "the table has no rows");
    assert.equal(rows.length, bodyRows, "a row has no row header, so its cells are not tied to a post");
    for (const [row] of rows) assert.equal((row.match(/<t[hd][\s>]/g) ?? []).length, 3, `a row lost a cell:\n${row}`);
  } finally {
    cleanup(dist);
  }
});

test("tripwire: published uploads are never served as immutable", () => {
  // §3.3 chose human-readable names over content hashes, and the price is that
  // a URL cannot be cached forever. An `immutable` rule copied from the fonts
  // entry would pin a stale image in readers' browsers for a year.
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const sample = "/images/uploads/a-post/diagram.png";
  const matching = (config.headers ?? []).filter((rule) =>
    new RegExp(`^${rule.source.replace(/\(\.\*\)/g, ".*")}$`).test(sample));

  assert.ok(matching.length > 0, "no header rule covers /images/uploads/");
  const values = matching.flatMap((rule) => rule.headers.map((h) => `${h.key}: ${h.value}`));
  assert.ok(!values.some((v) => /immutable/i.test(v)), `uploads are cached as immutable:\n  ${values.join("\n  ")}`);
  assert.ok(values.some((v) => /must-revalidate/i.test(v)), "uploads are not revalidated");
});

test("tripwire: the editor's preview frame is sandboxed with no permissions at all", async () => {
  // Measured in Chromium (scripts/verify-preview-sandbox.mjs): without this
  // attribute, a same-origin script placed in the preview runs and reaches the
  // editor. It is the lock that still holds if the sanitizer ever fails, and a
  // single allow-* token added for convenience would quietly remove it.
  const { editorPage } = await import("../lib/server/pages.mjs");
  const frame = editorPage().match(/<iframe\b[^>]*\bid="preview-frame"[^>]*>/);
  assert.ok(frame, "the preview frame is missing from the editor");
  const sandbox = frame[0].match(/\bsandbox="([^"]*)"/);
  assert.ok(sandbox, "the preview frame has no sandbox attribute");
  assert.equal(sandbox[1].trim(), "", `the preview frame was granted: ${sandbox[1]}`);
  assert.match(frame[0], /referrerpolicy="no-referrer"/, "preview requests would leak the editor URL");
});

/** The inline script a listing page runs in its head to pick a view. */
async function viewScript() {
  const { listPage } = await import("../lib/templates.mjs");
  const post = {
    slug: "a", title: "A", date: "2026-01-01T00:00:00.000Z", description: "", tags: [],
    readingTime: 1, math: false, html: "<p>a</p>", scripts: [], styles: [], head: "", distill: false,
  };
  const match = listPage([post]).match(/<head>[\s\S]*?<script>(\(function\(\)\{[\s\S]*?)<\/script>/);
  assert.ok(match, "the listing page has no view script in its head");
  return match[1];
}

/** Run it against a stand-in browser. Returns the view it chose. */
async function chooseView({ search = "", stored = null, storage = "ok" } = {}) {
  const vm = await import("node:vm");
  const { VIEW_STORAGE_KEY } = await import("../lib/templates.mjs");
  const root = {};
  const context = {
    URLSearchParams,
    location: { search },
    document: { documentElement: { setAttribute: (name, value) => { root[name] = value; } } },
  };
  // Browsers refuse storage two ways: the property itself throws (storage
  // disabled, some sandboxed frames), or reading from it does (quota, policy).
  Object.defineProperty(context, "localStorage", {
    get() {
      if (storage === "property-throws") throw new Error("SecurityError: The operation is insecure.");
      return {
        getItem(key) {
          if (storage === "read-throws") throw new Error("SecurityError: Access is denied.");
          return key === VIEW_STORAGE_KEY ? stored : null;
        },
      };
    },
  });
  vm.runInNewContext(await viewScript(), context);
  return root["data-view"] ?? "feed";
}

test("tripwire: the listing view survives refused storage and odd addresses", async () => {
  assert.equal(await chooseView(), "feed", "the default must be the feed");
  assert.equal(await chooseView({ stored: "table" }), "table", "a remembered choice was ignored");
  assert.equal(await chooseView({ stored: "grid" }), "feed", "an unknown stored value was honoured");
  assert.equal(await chooseView({ search: "?view=table" }), "table");
  assert.equal(await chooseView({ search: "?view=feed", stored: "table" }), "feed", "the address must outrank storage");
  assert.equal(await chooseView({ search: "?view=TABLE", stored: "feed" }), "feed", "an unknown address value was honoured");
  assert.equal(await chooseView({ search: "?view=bogus", stored: "table" }), "table", "an unknown address value hid the remembered choice");
  for (const storage of ["property-throws", "read-throws"]) {
    assert.equal(await chooseView({ storage }), "feed", `${storage}: refused storage must fall back, not throw`);
    assert.equal(await chooseView({ storage, search: "?view=table" }), "table", `${storage}: the address must still work`);
  }
});

test("tripwire: the head script and blog.js remember the view under the same key", async () => {
  const { VIEW_STORAGE_KEY } = await import("../lib/templates.mjs");
  const client = fs.readFileSync(path.join(ROOT, "assets", "blog.js"), "utf8");
  assert.ok(client.includes(`"${VIEW_STORAGE_KEY}"`), `blog.js does not use ${VIEW_STORAGE_KEY}, so a choice would not survive a reload`);
});

/** Flat list of style rules with the at-rules enclosing each. */
function styleRules(css, atRules = []) {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace === -1) break;
    const prelude = css.slice(i, brace).trim().replace(/\s+/g, " ");
    let depth = 1, j = brace + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const body = css.slice(brace + 1, j - 1);
    if (prelude.startsWith("@")) rules.push(...styleRules(body, [...atRules, prelude]));
    else for (const selector of prelude.split(",")) rules.push({ selector: selector.trim(), body, atRules });
    i = j;
  }
  return rules;
}

test("tripwire: without a chosen table, readers get the feed; the switch needs script to appear", () => {
  const css = fs.readFileSync(path.join(ROOT, "assets", "styles", "blog.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = styleRules(css);
  const display = (rule) => rule.body.match(/display\s*:\s*([a-z-]+)/)?.[1];
  const chosen = (rule) => /\[data-view="table"\]/.test(rule.selector) && !/:not\(/.test(rule.selector);

  const hidesFeed = rules.filter((r) => /\.listing-feed\b/.test(r.selector) && display(r) === "none");
  assert.ok(hidesFeed.length > 0, "nothing ever hides the feed, so the table view cannot work");
  for (const rule of hidesFeed) {
    assert.ok(chosen(rule), `"${rule.selector}" hides the feed without the reader choosing the table — no-script readers would see nothing`);
  }

  const tableRules = rules.filter((r) => /\.listing-table\b/.test(r.selector) && display(r));
  assert.ok(tableRules.some((r) => r.selector === ".listing-table" && display(r) === "none" && !r.atRules.length),
    "the table is not hidden by default, so both views would show at once");
  const showsTable = tableRules.filter((r) => display(r) !== "none");
  assert.ok(showsTable.length > 0, "nothing shows the table once it is chosen");
  for (const rule of showsTable) {
    assert.ok(chosen(rule), `"${rule.selector}" shows the table without it being chosen`);
  }

  // Hiding must be display:none, which also removes the view from the tab order
  // and the accessibility tree; opacity or visibility would leave it reachable.
  for (const rule of rules.filter((r) => /\.listing-(feed|table)\b/.test(r.selector))) {
    assert.ok(!/(visibility\s*:\s*hidden|opacity\s*:\s*0\b)/.test(rule.body), `"${rule.selector}" hides a view but leaves it focusable`);
  }

  const switchRules = rules.filter((r) => /\.view-switch$/.test(r.selector) && display(r));
  assert.ok(switchRules.some((r) => r.selector === ".view-switch" && display(r) === "none"), "the switch shows without script, where it cannot work");
  for (const rule of switchRules.filter((r) => display(r) !== "none")) {
    assert.match(rule.selector, /\.js\b/, `"${rule.selector}" shows the switch without script`);
  }
});

test("tripwire: the reveal fires for elements taller than the screen", () => {
  // A positive threshold is a fraction of the element that must be visible. A
  // post body ten screens tall can never show a tenth of itself, and Chromium
  // then never reports it intersecting: with 0.1 every long post rendered
  // blank for readers with script on and motion allowed. Measured, not assumed
  // (scripts/verify-listing.mjs).
  const client = fs.readFileSync(path.join(ROOT, "assets", "blog.js"), "utf8").replace(/\/\/.*$/gm, "");
  const observers = [...client.matchAll(/new IntersectionObserver\([\s\S]*?\{([^{}]*)\}\s*\)/g)];
  assert.ok(observers.length > 0, "no reveal observer found, but .fade-up content still starts hidden");
  for (const [, options] of observers) {
    const threshold = options.match(/threshold\s*:\s*([^,}\s]+)/)?.[1] ?? "0";
    assert.equal(threshold, "0", `the reveal observer uses threshold ${threshold}, which tall content never reaches`);
    assert.ok(!/rootMargin\s*:\s*["'][^"']*-/.test(options), "a negative rootMargin can leave content at the page bottom unrevealed");
  }
});

test("tripwire: a heading cannot collide with the page's own chrome ids", () => {
  // Every page inlines an SVG sprite whose symbols have ids like `icon-github`.
  // A heading slugs by the same rules, so `## Icon github` produced a second
  // element with that id: invalid HTML, and the heading's own permalink jumped
  // to the hidden sprite rather than the heading. Listings were always safe,
  // because lib/markup.mjs namespaces ids there; the post's own page was not.
  const dist = buildFixtures({ postsDir: defect("chrome-collision") });
  try {
    const page = fs.readFileSync(path.join(dist, "collides", "index.html"), "utf8");
    const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dupes, [], "the post page repeats an id");

    // The property that makes it impossible rather than unlikely: heading ids
    // come from the same slugify as post slugs, which collapses runs of
    // separators, so no heading id can contain "--". Every chrome id does.
    const headings = [...page.matchAll(/<h[234] id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(headings.length >= 2, "the fixture should have headings");
    for (const id of headings) assert.ok(!id.includes("--"), `heading id "${id}" contains --`);
    for (const [, id] of page.matchAll(/<symbol id="([^"]+)"/g)) {
      assert.ok(id.includes("--"), `chrome id "${id}" is reachable by a heading slug`);
    }
  } finally {
    cleanup(dist);
  }
});

test("tripwire: a heading permalink is reachable, not hidden from the people using it", () => {
  // aria-hidden on a focusable link is a contradiction: a screen-reader user
  // tabs onto an element that announces nothing. Either it is decorative and
  // unfocusable, or it is real and named.
  const dist = buildFixtures({ postsDir: defect("chrome-collision") });
  try {
    const page = fs.readFileSync(path.join(dist, "collides", "index.html"), "utf8");
    const anchors = [...page.matchAll(/<a class="heading-anchor"[^>]*>/g)].map((m) => m[0]);
    assert.ok(anchors.length >= 2, "no heading permalinks were rendered");
    for (const tag of anchors) {
      const hidden = /aria-hidden="true"/.test(tag);
      const focusable = !/tabindex="-1"/.test(tag);
      assert.ok(!(hidden && focusable), `a focusable permalink is hidden from assistive technology: ${tag}`);
      if (focusable) assert.match(tag, /aria-label="[^"]+"/, `a reachable permalink has no name: ${tag}`);
    }
    // Each link is named after its own heading, or a list of links is twenty
    // identical entries. A heading carrying a quote must not break the attribute.
    const labels = [...page.matchAll(/<a class="heading-anchor"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(new Set(labels).size, labels.length, "permalinks share a name");
    const hostile = labels.find((l) => l.includes("ampersand"));
    assert.ok(hostile, "the fixture heading with a quote and an ampersand did not render");
    assert.ok(hostile.includes("&quot;") && hostile.includes("&amp;"),
      `a heading's punctuation reached the attribute unescaped: ${hostile}`);
  } finally {
    cleanup(dist);
  }
});

test("tripwire: a description does not keep the punctuation of maths it drops", () => {
  // Descriptions are derived from the body when the author gives none, and
  // inline maths is dropped rather than rendered. Dropping `$x$` from
  // "identity, $x$, ties" left "identity, , ties" in the meta description,
  // the social card and the RSS summary.
  const cases = [
    ["Euler's identity, $e^{i\\pi}+1=0$, ties five constants.", /identity, ties/],
    ["The bound $n$ grows.", /^The bound grows\.$/],
    ["Given $$x$$; therefore done.", /^Given; therefore done\.$/],
  ];
  for (const [source, expected] of cases) {
    const text = toPlainText(source);
    assert.ok(!/\s[,;:]/.test(text), `punctuation left stranded: "${text}"`);
    assert.ok(!/([,;:])\s*\1/.test(text), `punctuation doubled: "${text}"`);
    assert.match(text, expected);
  }
});
