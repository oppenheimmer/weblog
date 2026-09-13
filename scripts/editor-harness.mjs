// The local stand-in both editor browser checks drive (CLAUDE.md Step 5, Step 7).
//
// The real API handlers and editor page over an in-memory bucket, behind a local
// server that also stands in for the deployment: it serves the build manifest,
// and a check finishes a build by writing into that manifest what the index
// holds at the time. Uploads go to a test-only PUT endpoint that writes the exact
// pending key into the fake bucket, so Chromium still performs the real sign ->
// PUT -> complete flow. Chromium is driven over the DevTools protocol.
//
// Nothing leaves the machine: no R2, no Vercel, no public site.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startDevTools, browserVersion } from "./chromium.mjs";

import { createStore } from "../lib/server/r2.mjs";
import { createSessionStore } from "../lib/server/sessions.mjs";
import { createRateLimiter } from "../lib/server/rate-limit.mjs";
import { hashPassword } from "../lib/server/passwords.mjs";
import { setContext } from "../lib/server/http.mjs";
import { createPublisher } from "../lib/server/publish.mjs";
import { createFakeS3, FAKE_CONFIG } from "../test/helpers/fake-r2.mjs";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PASSWORD = "a-local-passphrase";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ROUTES = [
  [/^\/(editor|login)\/?$/, (m) => `api/${m[1]}.js`],
  [/^\/api\/auth\/(login|logout|session)\/$/, (m) => `api/auth/${m[1]}.js`],
  [/^\/api\/drafts\/$/, () => "api/drafts/index.js"],
  [/^\/api\/drafts\/(p_[0-9a-f]{16})\/$/, () => "api/drafts/[id]/index.js", (m) => ({ id: m[1] })],
  [/^\/api\/(uploads|preview)\/$/, (m) => `api/${m[1]}/index.js`],
  // vercel.json rewrites these to the preview function; the handler reads the
  // grant from the path when no query carries it.
  [/^\/api\/preview\/run\/[^/]+\/.*$/, () => "api/preview/index.js"],
  [/^\/api\/publish\/$/, () => "api/publish.js"],
];
const STATIC = {
  "/assets/editor.js": ["assets/editor.js", "text/javascript"],
  "/assets/blog.js": ["assets/blog.js", "text/javascript"],
  "/assets/preview-run.js": ["assets/preview-run.js", "text/javascript"],
  "/assets/vendor/d3.v7.9.0.min.js": ["assets/vendor/d3.v7.9.0.min.js", "text/javascript"],
  "/assets/vendor/distill.template.v2.js": ["assets/vendor/distill.template.v2.js", "text/javascript"],
  "/assets/login.js": ["assets/login.js", "text/javascript"],
  "/styles/blog.css": ["assets/styles/blog.css", "text/css"],
  "/styles/editor.css": ["assets/styles/editor.css", "text/css"],
  "/favicon.svg": ["assets/favicon.svg", "image/svg+xml"],
};

// `editorScript` rewrites the editor's own code before it is served, so a
// check can run its control against a deliberately broken editor.
export async function startEditorHarness({ shots = null, editorScript = (text) => text } = {}) {
  let SITE = null;

  // ---- the backend --------------------------------------------------------------
  const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
  const hooks = [];
  const sessions = createSessionStore(store, { authVersion: 1 });
  // Request logs are collected rather than printed, so a check can read every
  // line a whole browser session produced (lib/server/log.mjs).
  const logLines = [];
  setContext({
    log: (line) => logLines.push(line),
    store,
    sessions,
    limiter: createRateLimiter(store, { secret: "verify-editor" }),
    fireDeployHook: async () => {
      hooks.push(Date.now());
      return { job: `local-${hooks.length}` };
    },
    signPut: async (key) => `${SITE}/local-upload/${Buffer.from(key).toString("base64url")}`,
    signGet: async (key) => `${SITE}/local-download/${Buffer.from(key).toString("base64url")}`,
    runSecret: "verify-editor-run",
  });
  process.env.ADMIN_PASSWORD_HASH = await hashPassword(PASSWORD, { N: 1024, r: 8, p: 1, keyLength: 32 });

  // The deployment this server pretends to be. A build finishing means the
  // manifest names whatever the index holds at that moment.
  const publisher = createPublisher(store, { fireDeployHook: async () => ({}) });
  const deployment = { status: 200, manifest: { commit: "local", posts: [] } };
  async function finishBuild() {
    const { data } = await publisher.readIndex();
    deployment.manifest.posts = Object.entries(data.posts ?? {})
      .map(([slug, entry]) => ({ slug, postId: entry.postId, revisionId: entry.revisionId }));
  }

  const serverErrors = [];
  // Every request, with whether it carried a cookie and which origin sent it:
  // the oracle for what a sandboxed frame could and could not do. `/hit/`
  // paths are beacons a page under test sends, answered and only recorded.
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    requests.push({
      path: url.pathname, search: url.search, method: req.method,
      origin: req.headers.origin ?? null, cookie: Boolean(req.headers.cookie),
    });
    if (url.pathname.startsWith("/hit/")) {
      res.writeHead(204);
      return res.end();
    }
    // The one piece of Vercel's response helpers the handlers use.
    res.status = (code) => { res.statusCode = code; return res; };
    try {
      if (url.pathname.startsWith("/local-upload/") && req.method === "PUT") {
        const key = Buffer.from(url.pathname.slice("/local-upload/".length), "base64url").toString("utf8");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        await store.put(key, Buffer.concat(chunks), { contentType: req.headers["content-type"] });
        res.writeHead(200, { "access-control-allow-origin": SITE });
        return res.end();
      }
      if (url.pathname.startsWith("/local-download/") && req.method === "GET") {
        const key = Buffer.from(url.pathname.slice("/local-download/".length), "base64url").toString("utf8");
        const object = await store.get(key);
        if (!object) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": object.contentType, "cache-control": "no-store" });
        return res.end(object.body);
      }
      if (url.pathname === "/build-manifest.json") {
        res.writeHead(deployment.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(deployment.manifest));
      }
      for (const [pattern, file, params] of ROUTES) {
        const match = url.pathname.match(pattern);
        if (!match) continue;
        req.query = { ...Object.fromEntries(url.searchParams), ...(params ? params(match) : {}) };
        const handler = (await import(pathToFileURL(path.join(ROOT, file(match))).href)).default;
        return await handler(req, res);
      }
      const asset = STATIC[url.pathname];
      if (asset && fs.existsSync(path.join(ROOT, asset[0]))) {
        res.writeHead(200, { "content-type": asset[1] });
        const text = fs.readFileSync(path.join(ROOT, asset[0]));
        return res.end(url.pathname === "/assets/editor.js" ? editorScript(text.toString("utf8")) : text);
      }
      res.writeHead(404);
      res.end();
    } catch (err) {
      serverErrors.push(`${url.pathname}: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  SITE = `http://127.0.0.1:${server.address().port}`;
  // Both the origin allowlist and the site check read this.
  process.env.SITE_URL = SITE;

  // ---- a small DevTools protocol client -----------------------------------------
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-editor-"));
  console.log(browserVersion());
  // Exits 2 with the browser's own words if it cannot start (scripts/chromium.mjs).
  const { chrome, url } = await startDevTools(path.join(work, "profile"));
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  const scriptErrors = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(`${message.error.message} (${message.error.code})`)) : resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      scriptErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

  function waitFor(sessionId, method, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeout);
      const listener = (message) => {
        if (message.sessionId === sessionId && message.method === method) {
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(message.params);
        }
      };
      listeners.add(listener);
    });
  }

  const pages = [];
  async function openPage({ width = 1440, height = 900 } = {}) {
    const { browserContextId } = await send("Target.createBrowserContext");
    const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call("Page.enable");
    await call("Runtime.enable");
    const resize = (w, h) => call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await resize(width, height);

    // Every confirm() is answered yes, and its wording kept so checks can read it.
    const dialogs = [];
    listeners.add((message) => {
      if (message.sessionId === sessionId && message.method === "Page.javascriptDialogOpening") {
        dialogs.push(message.params.message);
        call("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
    });

    // Where to click, once the element has stopped moving. A single measurement
    // was stale whenever something scrolled on a later frame — Chromium scrolls
    // a focused field's caret back into view after its value changes, so a
    // click aimed at Publish while Slug held focus landed on nothing.
    // The element is found again on every pass: lists re-render on each site
    // check, and a detached button measures as a 0×0 box in the corner.
    const boxOf = (finder) => page.eval(`(async () => {
      const frame = () => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
        setTimeout(resolve, 100);
      });
      let last = null;
      for (let i = 0; i < 10; i++) {
        const el = ${finder};
        if (!el) return last;
        el.scrollIntoView({ block: "center", behavior: "instant" });
        await frame();
        const r = el.getBoundingClientRect();
        const box = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        if (last && last.x === box.x && last.y === box.y) return box;
        last = box;
      }
      return last;
    })()`);
    const clickAt = async (box, what) => {
      if (!box) throw new Error(`nothing matches ${what}`);
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    };

    const page = {
      call,
      send,
      sessionId,
      targetId,
      browserContextId,
      dialogs,
      resize,
      boxOf,
      async goto(target) {
        const loaded = waitFor(sessionId, "Page.loadEventFired");
        await call("Page.navigate", { url: target });
        await loaded;
      },
      async reload() {
        const loaded = waitFor(sessionId, "Page.loadEventFired");
        await call("Page.reload");
        await loaded;
      },
      async eval(expression) {
        const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (exceptionDetails) throw new Error(`evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
        return result.value;
      },
      /** Poll until `expression` is truthy, and return its value. Tolerates a page mid-navigation. */
      async until(expression, timeout = 15_000) {
        const started = Date.now();
        let last;
        while (Date.now() - started < timeout) {
          try {
            last = await page.eval(expression);
            if (last) return last;
          } catch (err) {
            last = err.message;
          }
          await sleep(200);
        }
        throw new Error(`timed out after ${timeout} ms (last: ${JSON.stringify(last)})`);
      },
      click: (selector) => boxOf(`document.querySelector(${JSON.stringify(selector)})`).then((box) => clickAt(box, selector)),
      clickText: (selector, text) => boxOf(
        `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(text)}))`
      ).then((box) => clickAt(box, `${selector} containing ${text}`)),
      /** Set a field as typing would, through the input event the editor listens to. */
      type: (selector, value) => page.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })()`),
      /** A real key press, as the browser's own input pipeline delivers it. */
      async press(key, { shift = false, ctrl = false, commands } = {}) {
        const KEYS = {
          Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
          Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
          Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
          " ": { code: "Space", windowsVirtualKeyCode: 32, text: " " },
          s: { code: "KeyS", windowsVirtualKeyCode: 83 },
          v: { code: "KeyV", windowsVirtualKeyCode: 86 },
        };
        const spec = KEYS[key];
        const modifiers = (shift ? 8 : 0) | (ctrl ? 2 : 0);
        const text = modifiers & 2 ? undefined : spec.text;
        await call("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown", key, code: spec.code,
          windowsVirtualKeyCode: spec.windowsVirtualKeyCode, modifiers, text, commands,
        });
        await call("Input.dispatchKeyEvent", {
          type: "keyUp", key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, modifiers,
        });
      },
      /** The next time this page emits a DevTools event, such as a file chooser opening. */
      waitFor: (method, timeout) => waitFor(sessionId, method, timeout),
      /** Real typed text, one input event per call, as an IME or keyboard would send it. */
      insertText: (text) => call("Input.insertText", { text }),
      async screenshot(name) {
        if (!shots) return;
        const { data } = await call("Page.captureScreenshot", { format: "png" });
        fs.mkdirSync(shots, { recursive: true });
        fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, "base64"));
      },
      close: () => send("Target.closeTarget", { targetId }).then(() => send("Target.disposeBrowserContext", { browserContextId })),
    };
    pages.push(page);
    return page;
  }

  // ---- checks -----------------------------------------------------------------
  const results = [];
  async function check(name, fn) {
    try {
      const ok = await fn();
      results.push(ok === true);
      console.log(`  ${ok === true ? "ok  " : "FAIL"}  ${name}${ok === true || ok === false ? "" : `  (${JSON.stringify(ok)})`}`);
    } catch (err) {
      results.push(false);
      console.log(`  FAIL  ${name}  (${err.message})`);
    }
  }

  async function shutdown() {
    for (const page of pages) await page.close().catch(() => {});
    socket.close();
    chrome.kill();
    server.close();
    await sleep(200);
    fs.rmSync(work, { recursive: true, force: true });
  }

  /** Report and exit: 0 when every check passed, 1 when any did not. */
  function finish() {
    const failed = results.filter((ok) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
    process.exit(failed ? 1 : 0);
  }

  return {
    SITE, store, sessions, hooks, publisher, deployment, finishBuild, work, logLines, requests,
    openPage, check, results, scriptErrors, serverErrors, shutdown, finish,
  };
}
