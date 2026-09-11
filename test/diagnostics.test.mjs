// Tier 2 — renderer diagnostics (CLAUDE.md Step 1).
//
// Run against real renderer output, not hand-written HTML, because the whole
// module is a bet on what KaTeX and unified-latex emit when they give up.
import test from "node:test";
import assert from "node:assert/strict";

import { renderDiagnostics } from "../lib/diagnostics.mjs";
import { renderLatex } from "../lib/latex.mjs";
import { mdBrowser } from "../lib/markdown.mjs";

const seen = (html) => renderDiagnostics(html).map((d) => `${d.code}:${d.subject}`);

test("a clean document produces no diagnostics", () => {
  assert.deepEqual(renderDiagnostics(mdBrowser.render("# Hi\n\nText with $x^2$ and `code`.")), []);
  assert.deepEqual(renderDiagnostics(renderLatex(
    "\\section{Hi}\n\\textbf{b} \\emph{e} $x^2$\n\\begin{itemize}\\item a\\end{itemize}"
  )), []);
});

test("a KaTeX parse error is reported with its reason, entities decoded", () => {
  const [diagnostic] = renderDiagnostics(mdBrowser.render("Broken: $\\frac{1}{$"));
  assert.equal(diagnostic.level, "warning");
  assert.equal(diagnostic.code, "math_error");
  assert.match(diagnostic.message, /Unexpected end of input/);
  assert.ok(!/&#x27;|&amp;/.test(diagnostic.message), "HTML entities were left in the message");
});

test("an unknown maths command is reported by name", () => {
  assert.deepEqual(seen(mdBrowser.render("$\\notacommand{x}$")), ["unknown_math_command:notacommand"]);
});

test("unsupported LaTeX commands and environments are reported; layout-only ones are not", () => {
  const found = seen(renderLatex(
    "\\label{sec:a} \\cite{knuth} \\centering \\noindent\n\\begin{tikzpicture}\\draw;\\end{tikzpicture}"
  ));
  assert.ok(found.includes("unsupported_command:label"), found.join(" | "));
  assert.ok(found.includes("unsupported_command:cite"));
  assert.ok(found.includes("unsupported_environment:tikzpicture"));
  assert.ok(!found.includes("unsupported_command:centering"));
  assert.ok(!found.includes("unsupported_command:noindent"));
});

test("a repeated problem is reported once, with a count", () => {
  const diagnostics = renderDiagnostics(renderLatex("\\foo{a} \\foo{b} \\foo{c}"));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].count, 3);
  assert.match(diagnostics[0].message, /\(3 times\)/);
});

test("prose that merely mentions renderer markup is not mistaken for it", () => {
  const html = mdBrowser.render(
    'Write `class="macro macro-foo"` in code, or class="katex-error" title="x" in prose.'
  );
  assert.deepEqual(renderDiagnostics(html), []);
});

test("every diagnostic here is a warning — publish refusals come from elsewhere", () => {
  const all = renderDiagnostics(renderLatex("\\foo{x} $\\frac{1}{$ \\begin{tikzpicture}\\end{tikzpicture}"));
  assert.ok(all.length >= 3);
  assert.ok(all.every((d) => d.level === "warning"));
});
