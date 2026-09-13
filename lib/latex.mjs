// LaTeX (.tex) -> HTML via the pure-JS unified-latex pipeline.
// Math is rendered with the same build-time KaTeX engine used for Markdown, so
// `.tex` posts carry the `katex` class and reuse the per-page KaTeX-CSS gating.
import { unified } from "unified";
import { unifiedLatexFromString } from "@unified-latex/unified-latex-util-parse";
import { unifiedLatexToHast } from "@unified-latex/unified-latex-to-hast";
import rehypeStringify from "rehype-stringify";
import katex from "katex";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

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

/** Render LaTeX here and now, with no time limit. The worker below calls this. */
export function renderLatexNow(tex, { trusted = false } = {}) {
  const html = String(processorFor(trusted).processSync(tex));
  return renderMath(html);
}

// ------------------------------------------------------------------ time limit
//
// Input size bounds the work (1 MB body, 1 MiB expanded) but not its time, and
// a render is synchronous, so nothing on this thread can stop one. It runs on a
// worker instead, and this thread waits for it with a deadline: a render past
// the limit has its worker terminated and becomes a refusal, while every caller
// keeps a synchronous function.
//
// Measured on the owner's machine (2026-09-13): 1 MB of ordinary prose and
// maths, the largest body a draft may hold, takes 9–14 s; a long real post of
// about 80 KB, around a second. Ten seconds refuses only a post far beyond what
// preview can usefully show, and stops anything that grows faster than its
// input. Starting the worker and loading the renderer do not count against it.

export const LATEX_TIME_LIMIT_MS = 10_000;
const STARTUP_ALLOWANCE_MS = 30_000;
const IDLE = 0;
const STARTED = 1;
const DONE = 2;

/** A render that ran past its limit, or could not run at all. */
export class LatexRenderError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "LatexRenderError";
    this.code = code;
  }
}

// A module from a data: URL, which is always ESM whatever the package or the
// parent's flags say (an eval'd worker was CommonJS or not depending on how the
// process started, and one that threw on its first line hung the wait). It
// imports this file for the renderer, which every bundle rendering LaTeX has.
const WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
const state = new Int32Array(workerData.state);
const loading = import(workerData.module);
parentPort.on("message", async (job) => {
  let reply;
  try {
    const { renderLatexNow } = await loading;
    Atomics.store(state, 0, ${STARTED});
    Atomics.notify(state, 0);
    reply = { html: renderLatexNow(job.tex, { trusted: job.trusted }) };
  } catch (err) {
    reply = { error: { name: String(err && err.name), message: String(err && err.message) } };
  }
  workerData.port.postMessage(reply);
  Atomics.store(state, 0, ${DONE});
  Atomics.notify(state, 0);
});
`;

let current = null;

function renderer() {
  if (current) return current;
  const state = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`), {
    // Not the parent's flags: an --import preload would run again in here, and
    // one that renders LaTeX itself would wait on this worker for ever.
    execArgv: [],
    workerData: { state: state.buffer, port: port2, module: import.meta.url },
    transferList: [port2],
  });
  // An idle renderer must never keep a build or a test process alive.
  worker.unref();
  worker.on("error", () => { if (current?.worker === worker) current = null; });
  current = { worker, state, port: port1 };
  return current;
}

function stop(instance) {
  if (current === instance) current = null;
  instance.worker.terminate().catch(() => {});
  instance.port.close();
}

/**
 * Render LaTeX within a time limit. Untrusted unless the caller says otherwise,
 * like everything else. Throws LatexRenderError when the render runs past the
 * limit or overflows the parser's stack, which an author can act on.
 */
export function renderLatex(tex, {
  trust = DEFAULT_TRUST,
  // BLOG_LATEX_TIME_LIMIT_MS lets a test shorten the limit, like the other
  // BLOG_* overrides; unset in normal use.
  timeoutMs = Number(process.env.BLOG_LATEX_TIME_LIMIT_MS) || LATEX_TIME_LIMIT_MS,
} = {}) {
  const instance = renderer();
  const { worker, state, port } = instance;
  Atomics.store(state, 0, IDLE);
  worker.postMessage({ tex: String(tex ?? ""), trusted: isTrusted(trust) });

  if (Atomics.wait(state, 0, IDLE, STARTUP_ALLOWANCE_MS) === "timed-out") {
    stop(instance);
    throw new LatexRenderError("The LaTeX renderer did not start.", { code: "latex_unavailable" });
  }
  if (Atomics.load(state, 0) === STARTED) Atomics.wait(state, 0, STARTED, timeoutMs);
  if (Atomics.load(state, 0) !== DONE) {
    stop(instance);
    throw new LatexRenderError(
      `This LaTeX took longer than ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} ` +
      "to render and was stopped. " +
      "Split it into smaller posts, or look for a construct that makes the renderer loop.",
      { code: "latex_timeout" }
    );
  }

  const reply = receiveMessageOnPort(port)?.message;
  if (!reply) {
    stop(instance);
    throw new LatexRenderError("The LaTeX renderer gave no answer.", { code: "latex_unavailable" });
  }
  if (reply.error) {
    if (reply.error.name === "RangeError" && /call stack/i.test(reply.error.message)) {
      throw new LatexRenderError(
        "This LaTeX nests too deeply to render: an unclosed group or environment, or thousands inside one another.",
        { code: "latex_too_deep" }
      );
    }
    throw Object.assign(new Error(reply.error.message), { name: reply.error.name });
  }
  return reply.html;
}

// Plain text from rendered HTML, for reading-time on .tex posts.
export function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
