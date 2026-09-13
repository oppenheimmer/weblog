// Tier 2/4 — LaTeX rendering has a time limit (CLAUDE.md Step 1).
//
// Input size bounds the work but not its time, and a render is synchronous, so
// it runs on a worker this thread waits for with a deadline. Asserted here: the
// worker renders exactly what rendering in-process does, a render past its
// limit is stopped at the limit rather than after it finishes, starting the
// worker is not charged to the author, and a stopped render reaches authors as
// the content refusal preview, publishing and the build already report.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { renderLatex, renderLatexNow, LatexRenderError, LATEX_TIME_LIMIT_MS } from "../lib/latex.mjs";
import { normalizePost, ContentError } from "../lib/content.mjs";
import { validateForPublish, PublishError } from "../lib/server/publish.mjs";
import { ENGINE, BROWSER } from "../lib/sanitize.mjs";
import { ROOT } from "./helpers/build-fixture.mjs";

const SAMPLE = [
  "\\section{Orbits}",
  "Kepler's third law: $T^2 \\propto a^3$, and in full",
  "\\[ T = 2\\pi \\sqrt{\\frac{a^3}{G(M+m)}} \\]",
  "\\begin{itemize}\\item one \\item two\\end{itemize}",
  "\\href{javascript:alert(1)}{a link that must not work} and \\url{https://example.com}",
  // Trust decides this one: only repository-authored TeX may show a remote image.
  "\\includegraphics{https://images.example/pixel.png}",
].join("\n");
// Ordinary TeX, just a lot of it: about a second to render on the owner's
// machine, far past the short limits below.
const LONG = "\\section{A} Prose with $x^2$ and \\[ \\int_0^1 x\\,dx \\]\n\n".repeat(2500);

test("the worker renders exactly what rendering in-process does, at both trust levels", () => {
  const browser = renderLatex(SAMPLE, { trust: BROWSER });
  const engine = renderLatex(SAMPLE, { trust: ENGINE });
  assert.equal(browser, renderLatexNow(SAMPLE, { trusted: false }));
  assert.equal(engine, renderLatexNow(SAMPLE, { trusted: true }));
  // The two differ, so the comparison above could fail if trust were lost on the way.
  assert.ok(engine.includes("images.example") && !browser.includes("images.example"),
    "trust did not reach the worker, or the sample no longer depends on it");
  assert.ok(!renderLatex(SAMPLE).includes("javascript:"), "the sanitizer did not run on the worker");
});

test("a render past its limit is stopped at the limit, and the next render runs", () => {
  renderLatex("$x$"); // the worker is started, so only the render is timed
  const started = Date.now();
  assert.throws(() => renderLatex(LONG, { timeoutMs: 150 }),
    (err) => err instanceof LatexRenderError && err.code === "latex_timeout" && /150 ms/.test(err.message));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `the render was waited out rather than stopped (${elapsed} ms)`);

  assert.equal(renderLatex(SAMPLE), renderLatexNow(SAMPLE), "a stopped worker left the renderer broken");
  // The control: the same input under the real limit renders, so the refusal
  // above was the limit's, not the input's.
  assert.match(renderLatex(LONG), /<h2|katex/);
});

test("starting the worker is not charged against the limit", () => {
  // A fresh process: the first render there pays for the worker and for
  // loading the renderer, hundreds of milliseconds, under a 50 ms limit.
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { renderLatex } from ${JSON.stringify(path.join(ROOT, "lib", "latex.mjs"))};
    const started = Date.now();
    const html = renderLatex("$x$", { timeoutMs: 50 });
    console.log(JSON.stringify({ ok: html.includes("katex"), ms: Date.now() - started }));
  `], { cwd: ROOT, encoding: "utf8" });
  const { ok, ms } = JSON.parse(output.trim().split("\n").at(-1));
  assert.ok(ok, "the first render in a process was refused");
  assert.ok(ms > 50, `startup was too fast to show anything (${ms} ms), so this measured nothing`);
});

test("a post too slow to render is refused as content, in the pipeline and by publishing", (t) => {
  process.env.BLOG_LATEX_TIME_LIMIT_MS = "150";
  t.after(() => { delete process.env.BLOG_LATEX_TIME_LIMIT_MS; });
  const post = { title: "Slow", date: "2026-07-01", slug: "slow" };

  assert.throws(() => normalizePost({ data: post, body: LONG, format: "latex", sourceName: "slow.tex" }),
    (err) => err instanceof ContentError && err.field === "body" && /slow\.tex.*longer than 150 ms/.test(err.message));
  assert.throws(() => validateForPublish({ ...post, body: LONG, format: "latex" }),
    (err) => err instanceof PublishError && err.code === "invalid_content" && err.field === "body");
});

test("the limit allows the largest ordinary post a draft may hold", () => {
  // 1 MB of prose and maths measured at 9–14 s; ten seconds keeps a post of a
  // few hundred kilobytes well inside it and still stops anything runaway.
  assert.equal(LATEX_TIME_LIMIT_MS, 10_000);
});
