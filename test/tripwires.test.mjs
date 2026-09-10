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
  const dist = buildFixtures();
  try {
    const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    if (html.includes('role="table"')) {
      // ARIA grid: every child of a row must carry a cell role.
      const rows = [...html.matchAll(/<div class="db-row"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="db-row"|<\/div>)/g)];
      assert.ok(rows.length > 0, "no rows found in the ARIA table");
      for (const [, body] of rows) {
        const children = [...body.matchAll(/<(span|time|div)\s[^>]*class="db-(title|tags|date)"[^>]*>/g)];
        for (const [tag] of children) {
          assert.match(tag, /role="cell"/, `row child is missing role="cell": ${tag}`);
        }
      }
    } else {
      assert.match(html, /<table[\s>]/, "listing is neither an ARIA table nor a native table");
    }
  } finally {
    cleanup(dist);
  }
});
