// Proves, in a real browser, what the editor says about the site (CLAUDE.md Step 7).
//
//   node scripts/verify-editor.mjs
//   node scripts/verify-editor.mjs --shots <dir>     # also save screenshots
//   CHROMIUM=/path/to/chrome node scripts/verify-editor.mjs
//
// Runs the real API handlers and editor page over an in-memory bucket, behind a
// local server that also stands in for the deployment: it serves the build
// manifest, and the script finishes a build by writing into that manifest what
// the index holds at the time. Chromium is driven over the DevTools protocol,
// as in scripts/verify-listing.mjs.
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
import { newPostId, newRevisionId } from "../lib/server/drafts.mjs";
import { createFakeS3, FAKE_CONFIG } from "../test/helpers/fake-r2.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const PASSWORD = "a-local-passphrase";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the backend ----------------------------------------------------------------

const store = createStore({ config: FAKE_CONFIG, client: createFakeS3() });
const hooks = [];
setContext({
  store,
  sessions: createSessionStore(store, { authVersion: 1 }),
  limiter: createRateLimiter(store, { secret: "verify-editor" }),
  fireDeployHook: async () => {
    hooks.push(Date.now());
    return { job: `local-${hooks.length}` };
  },
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

// A post migrated from the repository: published, live, and with no draft.
await publisher.publish({
  postId: newPostId(), revisionId: newRevisionId(1), version: 1,
  title: "Welcome", date: "2026-09-10", description: "", tags: [], format: "markdown",
  body: "Migrated, so it has no draft.", slug: "welcome",
});
await finishBuild();

const ROUTES = [
  [/^\/(editor|login)\/?$/, (m) => `api/${m[1]}.js`],
  [/^\/api\/auth\/(login|logout|session)\/$/, (m) => `api/auth/${m[1]}.js`],
  [/^\/api\/drafts\/$/, () => "api/drafts/index.js"],
  [/^\/api\/drafts\/(p_[0-9a-f]{16})\/$/, () => "api/drafts/[id]/index.js", (m) => ({ id: m[1] })],
  [/^\/api\/(uploads|preview)\/$/, (m) => `api/${m[1]}/index.js`],
  [/^\/api\/publish\/$/, () => "api/publish.js"],
];
const STATIC = {
  "/assets/editor.js": ["assets/editor.js", "text/javascript"],
  "/assets/login.js": ["assets/login.js", "text/javascript"],
  "/styles/blog.css": ["assets/styles/blog.css", "text/css"],
  "/styles/editor.css": ["assets/styles/editor.css", "text/css"],
  "/favicon.svg": ["assets/favicon.svg", "image/svg+xml"],
};

const serverErrors = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  // The one piece of Vercel's response helpers the handlers use.
  res.status = (code) => { res.statusCode = code; return res; };
  try {
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
      return res.end(fs.readFileSync(path.join(ROOT, asset[0])));
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
const SITE = `http://127.0.0.1:${server.address().port}`;
// Both the origin allowlist and the site check read this.
process.env.SITE_URL = SITE;

// ---- a small DevTools protocol client -------------------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-editor-"));
const profile = path.join(work, "profile");
console.log(browserVersion());
// Exits 2 with the browser's own words if it cannot start (scripts/chromium.mjs).
const { chrome, url } = await startDevTools(profile);
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

  const boxOf = (finder) => page.eval(`(() => {
    const el = ${finder};
    if (!el) return null;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const clickAt = async (box, what) => {
    if (!box) throw new Error(`nothing matches ${what}`);
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  };

  const page = {
    dialogs,
    resize,
    async goto(url) {
      const loaded = waitFor(sessionId, "Page.loadEventFired");
      await call("Page.navigate", { url });
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
    async screenshot(name) {
      if (!SHOTS) return;
      const { data } = await call("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    },
    close: () => send("Target.closeTarget", { targetId }).then(() => send("Target.disposeBrowserContext", { browserContextId })),
  };
  return page;
}

// ---- checks -------------------------------------------------------------------

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

const PANEL = `({
  hidden: document.getElementById("publication").hidden,
  chip: document.getElementById("publication-chip").textContent,
  summary: document.getElementById("publication-summary").textContent,
  revisions: [...document.getElementById("publication-revision").options].map((o) => o.textContent),
  rollback: document.getElementById("publication-rollback").textContent,
  rollbackDisabled: document.getElementById("publication-rollback").disabled,
  unpublish: !document.getElementById("publication-unpublish").hidden,
})`;
const chipIs = (label) => `document.getElementById("publication-chip").textContent === ${JSON.stringify(label)} && ${PANEL}`;
const listed = (text, label) =>
  `[...document.querySelectorAll("#publication-list button")].some((b) => b.textContent.includes(${JSON.stringify(text)}) && b.textContent.includes(${JSON.stringify(label)}))`;
// A build lands within the editor's first few checks after a change; the watch
// backs off to 30 seconds, so give each wait comfortably more than that.
const SETTLE_MS = 45_000;

let page;
try {
  page = await openPage();

  console.log("\nSigning in:");
  await page.goto(`${SITE}/login/`);
  await page.type("#password", PASSWORD);
  await page.click("#login-submit");
  await check("the password opens the editor", async () =>
    (await page.until(`location.pathname === "/editor/" && document.getElementById("save-state").textContent === "not saved"`)) === true);

  console.log("\nA post with no draft:");
  await check("the list shows it as live", () => page.until(listed("Welcome", "/welcome/ · Live")));
  await page.clickText("#publication-list button", "Welcome");
  await check("choosing it shows its panel, live, with Unpublish offered and nothing to roll back to", async () => {
    const p = await page.eval(PANEL);
    return (!p.hidden && p.chip === "Live" && p.summary.startsWith("“Welcome” is live at /welcome/") &&
      p.unpublish && p.rollbackDisabled) || p;
  });
  await check("and the form is left alone, since there is no draft to open",
    async () => (await page.eval(`document.getElementById("title").value`)) === "");

  console.log("\nPublishing:");
  await page.click("#new-post");
  await page.type("#title", "Lifecycle probe");
  await page.type("#body", "First text.");
  let before = hooks.length;
  await page.click("#publish");
  await check("Publish says published, and the panel says the site does not show it yet", async () => {
    const p = await page.until(`document.getElementById("save-state").textContent.startsWith("published") && ${chipIs("Not live yet")}`);
    return (/does not show it yet/.test(p.summary) && hooks.length === before + 1) || { p, hooks: hooks.length - before };
  });
  await page.screenshot("pending");
  await finishBuild();
  await check("when a build holds it, the panel turns Live with no reload and no click", async () => {
    const p = await page.until(chipIs("Live"), SETTLE_MS);
    return /is live at \/lifecycle-probe\/, showing revision 1\./.test(p.summary) || p;
  });

  console.log("\nIts address:");
  await page.type("#slug", "moved-elsewhere");
  await page.click("#publish");
  await check("publishing it under a new slug is refused, and not reported as published", async () => {
    const error = await page.until(`document.getElementById("editor-error").textContent || null`);
    const status = await page.eval(`document.getElementById("save-state").textContent`);
    const note = await page.eval(`document.getElementById("editor-published").textContent`);
    return (/cannot change while it is published/.test(error) && !status.startsWith("published") && note === "") ||
      { error, status, note };
  });
  await page.type("#slug", "lifecycle-probe");
  await page.type("#body", "Second text.");
  await page.click("#publish");
  await check("a new revision at the same address publishes, and the site is said to show the old one", async () => {
    const p = await page.until(`document.getElementById("save-state").textContent.startsWith("published") && ${chipIs("Updating")}`);
    return /still shows revision 1 until the rebuild finishes/.test(p.summary) || p;
  });
  await check("the revision choice moves to the new one, so a rollback is not offered by accident", async () => {
    const p = await page.eval(PANEL);
    const index = await page.eval(`document.getElementById("publication-revision").selectedIndex`);
    return (index === 0 && p.rollbackDisabled) || { index, p };
  });
  await check("the refused publish left no revision behind to roll back to", async () => {
    const { revisions } = await page.eval(PANEL);
    return (revisions.length === 2 && /^revision 3 .*\(published\)$/.test(revisions[0]) &&
      /^revision 1 .*\(on the site\)$/.test(revisions[1])) || revisions;
  });
  await page.screenshot("updating");
  await finishBuild();
  await page.until(chipIs("Live"), SETTLE_MS);

  console.log("\nRolling back:");
  await page.eval(`(() => {
    const select = document.getElementById("publication-revision");
    select.value = select.options[1].value;
    select.dispatchEvent(new Event("change"));
  })()`);
  await check("choosing the older revision offers to roll back to it", async () => {
    const p = await page.eval(PANEL);
    return (p.rollback === "Roll back to this revision" && !p.rollbackDisabled) || p;
  });
  await check("the choice survives the panel's next check of the site", async () => {
    await sleep(5000);
    return (await page.eval(`document.getElementById("publication-revision").selectedIndex`)) === 1;
  });
  await page.click("#publication-rollback");
  await check("confirmed, it points the index at that revision and the panel follows the site back", async () => {
    const updating = await page.until(chipIs("Updating"));
    const indexed = (await publisher.readIndex()).data.posts["lifecycle-probe"].revisionId;
    await finishBuild();
    const live = await page.until(chipIs("Live"), SETTLE_MS);
    return (/^Roll back “Lifecycle probe” to revision 1/.test(page.dialogs.at(-1)) && /^r_000001_/.test(indexed) &&
      /showing revision 1\./.test(live.summary)) || { updating, indexed, live, dialog: page.dialogs.at(-1) };
  });

  console.log("\nTaking it down:");
  await page.click("#discard");
  await check("discarding its draft while it is published is refused, saying what to do instead", async () => {
    const error = await page.until(`document.getElementById("editor-error").textContent || null`);
    const drafts = await page.eval(`[...document.querySelectorAll("#draft-list button")].map((b) => b.textContent)`);
    return (/Unpublish it before discarding its draft/.test(error) && drafts.some((d) => d.includes("Lifecycle probe"))) ||
      { error, drafts };
  });
  await page.click("#publication-unpublish");
  await check("Unpublish, confirmed, reads as coming down until a build drops it", async () => {
    const coming = await page.until(chipIs("Coming down"));
    await finishBuild();
    const gone = await page.until(chipIs("Unpublished"), SETTLE_MS);
    return (/^Take “Lifecycle probe” off the site\?/.test(page.dialogs.at(-1)) && !gone.unpublish &&
      gone.rollback === "Put back on the site" && !gone.rollbackDisabled && gone.revisions.length === 2) ||
      { coming, gone, dialog: page.dialogs.at(-1) };
  });
  await page.reload();
  await page.until(`document.getElementById("publication-list").textContent.includes("Lifecycle probe")`);
  await page.eval(`[...document.querySelectorAll("#publication-list button")]
    .find((button) => button.textContent.includes("Lifecycle probe")).click()`);
  await check("after a reload, Put back still defaults to the revision last on the site", async () => {
    const result = await page.until(`(() => {
      const chosen = document.getElementById("publication-revision").value || null;
      const title = document.getElementById("title").value;
      return (chosen && title) ? { chosen, title } : null;
    })()`);
    return (/^r_000001_/.test(result.chosen) && result.title === "Lifecycle probe") || result;
  });
  // The DevTools harness's synthetic mouse events stop reaching listeners after
  // reload on this Chromium build (Step 7); dispatch the real DOM click here.
  await page.eval(`document.getElementById("publication-rollback").click()`);
  await check("Put back publishes the chosen revision again", async () => {
    const waiting = await page.until(chipIs("Not live yet"));
    await finishBuild();
    const live = await page.until(chipIs("Live"), SETTLE_MS);
    return (/^Put back “Lifecycle probe” to revision 1/.test(page.dialogs.at(-1)) && /showing revision 1\./.test(live.summary)) ||
      { waiting, live };
  });

  console.log("\nRebuilding:");
  before = hooks.length;
  await page.click("#publication-rebuild");
  await check("Rebuild site calls the deploy hook once, then pauses the button", async () => {
    await page.until(`document.getElementById("publication-rebuild").disabled`);
    await sleep(500);
    return hooks.length === before + 1 || hooks.length - before;
  });

  console.log("\nA post with no draft, while another is open:");
  await page.clickText("#publication-list button", "Welcome");
  await check("its panel shows, and the open draft stays in the form", async () => {
    const p = await page.eval(PANEL);
    const title = await page.eval(`document.getElementById("title").value`);
    return (p.summary.startsWith("“Welcome”") && title === "Lifecycle probe") || { p, title };
  });
  await page.click("#publication-unpublish");
  await check("it can be unpublished from there, and only it", async () => {
    await page.until(chipIs("Coming down"));
    const { data } = await publisher.readIndex();
    return (!data.posts.welcome && Boolean(data.posts["lifecycle-probe"])) || Object.keys(data.posts);
  });

  console.log("\nWhen the build fails:");
  // The panel is waiting on a rebuild right now, which is exactly when a failed
  // build is indistinguishable from a slow one unless the build says so.
  const { keys: storeKeys } = await import("../lib/server/keys.mjs");
  await check("a failed build names its reason, rather than leaving the panel waiting", async () => {
    await store.put(storeKeys.lastBuildFailure, JSON.stringify({
      schemaVersion: 1, kind: "media", at: new Date().toISOString(), commit: "local",
      reason: "Published media for /welcome/ is missing: diagram.png",
    }));
    const waiting = await page.until(`/The last build failed/.test(
      document.getElementById("publication-summary").textContent) && ${PANEL}`, SETTLE_MS);
    const link = await page.eval(
      `(document.querySelector("#publication-summary a[href*='vercel.com']") || {}).textContent || null`);
    return (/missing: diagram\.png/.test(waiting.summary) && link === "The deployment list") ||
      { summary: waiting.summary, link };
  });
  await check("a build that succeeds clears it, and the panel stops saying so", async () => {
    await store.delete(storeKeys.lastBuildFailure);
    const quiet = await page.until(`!/The last build failed/.test(
      document.getElementById("publication-summary").textContent) && ${PANEL}`, SETTLE_MS);
    return !/The last build failed/.test(quiet.summary) || { summary: quiet.summary };
  });

  console.log("\nAfter a reload:");
  await page.reload();
  await check("what is still on its way is watched again, with no click", async () => {
    await page.until(listed("Welcome", "Coming down"));
    await finishBuild();
    return (await page.until(listed("Welcome", "Unpublished"), SETTLE_MS)) === true;
  });

  console.log("\nWhen the site cannot be read:");
  deployment.status = 503;
  await page.reload();
  await page.until(`document.querySelectorAll("#publication-list button").length === 2`);
  await page.clickText("#publication-list button", "Lifecycle probe");
  await check("the panel says it could not check, and why, rather than guessing", async () => {
    const p = await page.until(chipIs("Not checked"));
    return /could not be checked: the site answered 503/.test(p.summary) || p;
  });
  deployment.status = 200;

  console.log("\nWith no post selected:");
  await check("Rebuild site is still reachable, and sweeps while it rebuilds", async () => {
    // It used to live inside the per-post panel, which is hidden until a
    // published post is selected — so the one action that is about the site
    // rather than a post was unreachable on a blog with no posts.
    for (const publication of await publisher.listPublications()) {
      if (publication.published) await publisher.unpublish(publication.postId);
    }
    await finishBuild();
    // A fresh load with nothing selected: the per-post panel is hidden, which is
    // the state a blog with no posts is permanently in.
    await page.reload();
    await page.until(`document.getElementById("publication").hidden === true`);

    const before = hooks.length;
    const visible = await page.eval(`(() => {
      const b = document.getElementById("publication-rebuild");
      const panel = document.getElementById("publication");
      return { offered: Boolean(b) && b.offsetParent !== null, panelHidden: panel.hidden,
        disabledBefore: b.disabled };
    })()`);
    // A real click would land on the button and nothing else — checked with
    // elementFromPoint rather than assumed, since "visible" and "clickable" are
    // different claims.
    const hit = await page.eval(`(() => {
      const b = document.getElementById("publication-rebuild");
      b.scrollIntoView({ block: "center", behavior: "instant" });
      const r = b.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at ? (at.id || at.tagName) : null;
    })()`);

    // The click itself is dispatched in the page. Synthetic mouse events from
    // the protocol stop arriving after a reload in this harness — measured: the
    // button is enabled, elementFromPoint names it, and the handler still never
    // runs, while el.click() on the same element does. Every other check clicks
    // before a reload, which is why only this one meets it.
    await page.eval(`document.getElementById("publication-rebuild").click()`);
    await sleep(1500);
    const after = await page.eval(`({
      note: document.getElementById("rebuild-note").textContent,
      disabled: document.getElementById("publication-rebuild").disabled,
      error: document.getElementById("editor-error").textContent,
    })`);
    return (visible.offered && visible.panelHidden && hit === "publication-rebuild" &&
      hooks.length === before + 1 && after.disabled && !after.error &&
      /Rebuilding/.test(after.note)) || { visible, hit, after, fired: hooks.length - before };
  });

  console.log("\nPhone:");
  await page.resize(390, 844);
  await page.eval(`document.getElementById("publication").scrollIntoView({ block: "center", behavior: "instant" })`);
  await check("the panel fits the screen, and the page never scrolls sideways", async () => {
    const fit = await page.eval(`({
      scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
      panelRight: Math.round(document.getElementById("publication").getBoundingClientRect().right),
    })`);
    return (fit.scrollWidth <= fit.innerWidth && fit.panelRight <= fit.innerWidth) || fit;
  });
  await page.screenshot("phone");

  await check("no script error was thrown", () => scriptErrors.length === 0 || scriptErrors);
  await check("no request failed inside the server", () => serverErrors.length === 0 || serverErrors);
} finally {
  await page?.close().catch(() => {});
  socket.close();
  chrome.kill();
  server.close();
  await sleep(200);
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
