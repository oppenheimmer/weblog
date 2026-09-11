// Proves, in a real browser, what the listing pages promise (CLAUDE.md Step 8).
//
//   node scripts/verify-listing.mjs
//   node scripts/verify-listing.mjs --shots <dir>     # also save screenshots
//   CHROMIUM=/path/to/chrome node scripts/verify-listing.mjs
//
// Builds the fixture corpus with the real stylesheet and script, plus three
// posts made for this: two sharing a heading, and one far taller than the
// screen. Serves it, and drives Chromium over the DevTools protocol — Node's
// own WebSocket, no browser library — to click, type, reload and measure the
// way a reader would.
//
// The unit and contract tests pin the markup and the CSS rules. This checks
// what those cannot: that the rules actually produce the behaviour, including
// the paths that are easiest to break and hardest to notice — no script,
// reduced motion, refused storage, a phone, the keyboard.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROMIUM = process.env.CHROMIUM || "chromium-browser";
const SHOTS = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- corpus -------------------------------------------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), "weblog-listing-"));
const postsDir = path.join(work, "posts");
fs.cpSync(path.join(ROOT, "test", "fixtures", "content", "posts"), postsDir, { recursive: true });

const filler = (n) => Array.from({ length: n }, (_, i) =>
  `Paragraph ${i + 1} of filler, long enough to wrap across a line or two at any width so the article ` +
  `grows well past the height of the screen and the reveal has something tall to cope with.`).join("\n\n");
// Also carries content that cannot wrap — a long code line, a wide equation —
// which is what tries to push a feed card wider than a phone.
const wideCode = `const ${"reallyLongIdentifier".repeat(12)} = ${"'unbreakable'".repeat(8)};`;
const wideMaths = `$$${Array.from({ length: 24 }, (_, i) => `x_{${i}}^{2}`).join(" + ")} = 1$$`;
fs.writeFileSync(path.join(postsDir, "2026-07-08-anchors-one.md"),
  `---\ntitle: "Anchors, first"\ndate: 2026-07-08\ntags: [testing]\n---\n\n## Introduction\n\nThe first post's introduction.\n\n` +
  `\`\`\`js\n${wideCode}\n\`\`\`\n\n${wideMaths}\n\n${filler(6)}\n`);
fs.writeFileSync(path.join(postsDir, "2026-07-07-anchors-two.md"),
  `---\ntitle: "Anchors, second"\ndate: 2026-07-07\ntags: [testing]\n---\n\n## Introduction\n\nThe second post's introduction.\n\n${filler(12)}\n\n[Back to the introduction](#introduction)\n`);
fs.writeFileSync(path.join(postsDir, "2026-06-01-tall.md"),
  `---\ntitle: "A very long read"\ndate: 2026-06-01\n---\n\n${filler(400)}\n`);

const NEWEST_FIRST = ["Anchors, first", "Anchors, second", "Same date, alpha", "Same date, beta", "Per-post embed hooks",
  "A post with no tags", "A LaTeX-sourced note", "Markdown kitchen sink", "Setting up", "A very long read"];

function build(dist, env = {}) {
  execFileSync(process.execPath, [path.join(ROOT, "build.mjs")], {
    cwd: ROOT,
    env: { ...process.env, BLOG_POSTS_DIR: postsDir, BLOG_DIST_DIR: dist, ...env },
    stdio: "pipe",
  });
  fs.mkdirSync(path.join(dist, "images"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "test", "fixtures", "assets", "images", "diagram.png"), path.join(dist, "images", "diagram.png"));
  return dist;
}
const whole = build(path.join(work, "whole"));
const paged = build(path.join(work, "paged"), { BLOG_FEED_PAGE_BYTES: "1" });

// ---- servers ------------------------------------------------------------------

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
function serve(dir) {
  const server = http.createServer((req, res) => {
    let file = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const wholeServer = await serve(whole);
const pagedServer = await serve(paged);
const SITE = `http://127.0.0.1:${wholeServer.address().port}`;
const PAGED = `http://127.0.0.1:${pagedServer.address().port}`;

// ---- a small DevTools protocol client -------------------------------------------

const profile = path.join(work, "profile");
const chrome = spawn(CHROMIUM, [
  "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0",
  // Nothing leaves the machine: Google Fonts and the like resolve to nowhere.
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  "about:blank",
], { stdio: "ignore" });
chrome.on("error", (err) => {
  console.log(`Could not run ${CHROMIUM}: ${err.message}`);
  process.exit(2);
});

const portFile = path.join(profile, "DevToolsActivePort");
for (let i = 0; i < 400 && !fs.existsSync(portFile); i++) await sleep(50);
const [port, browserPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
const socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
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

async function openPage({ width = 1440, height = 900, reducedMotion = false, noScript = false, refuseStorage = false } = {}) {
  const { browserContextId } = await send("Target.createBrowserContext"); // its own storage
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" }],
  });
  if (noScript) await call("Emulation.setScriptExecutionDisabled", { value: true });
  // Records which view was chosen at the moment the feed first exists, which
  // is what tells a flash-free choice from one made after the feed painted.
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `new MutationObserver(function (records, observer) {
      if (document.querySelector(".listing-feed")) {
        window.__viewWhenFeedAppeared = document.documentElement.getAttribute("data-view") || "feed";
        observer.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });`,
  });
  if (refuseStorage) {
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: `Object.defineProperty(window, "localStorage", { configurable: true, get: function () {
        throw new DOMException("The operation is insecure.", "SecurityError"); } });`,
    });
  }

  const page = {
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
    /** Click the centre of the first element matching `selector`, as a mouse would. */
    async click(selector, { navigates = false } = {}) {
      const box = await page.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        // Instant: the site scrolls smoothly, and a box measured mid-animation
        // sends the click somewhere else.
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!box) throw new Error(`nothing matches ${selector}`);
      const loaded = navigates ? waitFor(sessionId, "Page.loadEventFired") : null;
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
      if (loaded) await loaded;
    },
    /** Resolve once the page has stopped scrolling, as after following an in-page link. */
    async settle() {
      let last = -1;
      for (let i = 0; i < 50; i++) {
        const y = await page.eval("window.scrollY");
        if (y === last) return;
        last = y;
        await sleep(120);
      }
    },
    async press(key) {
      const keys = {
        Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
        Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
        Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
      }[key];
      await call("Input.dispatchKeyEvent", { type: "keyDown", ...keys });
      await call("Input.dispatchKeyEvent", { type: "keyUp", ...keys, text: undefined });
    },
    async screenshot(name) {
      if (!SHOTS) return;
      const { cssContentSize } = await call("Page.getLayoutMetrics");
      const { data } = await call("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 6000), scale: 1 },
      });
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
    },
    close: () => send("Target.closeTarget", { targetId }).then(() => send("Target.disposeBrowserContext", { browserContextId })),
  };
  return page;
}

// ---- checks -------------------------------------------------------------------

const results = [];
/** Run a group of checks on its own page; a failure that stops the group is itself reported. */
async function section(title, options, fn) {
  console.log(`\n${title}`);
  const page = await openPage(options);
  try {
    await fn(page);
  } catch (err) {
    results.push(false);
    console.log(`  FAIL  the rest of this section could not run  (${err.message})`);
  } finally {
    await page.close().catch(() => {});
  }
}
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

const shown = (selector) => `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).display !== "none"`;
const VIEW_STATE = `({
  view: document.documentElement.getAttribute("data-view") || "feed",
  feed: ${shown(".listing-feed")},
  table: ${shown(".listing-table")},
  pressed: [...document.querySelectorAll("[data-view-option]")].map((b) => b.dataset.viewOption + "=" + b.getAttribute("aria-pressed")).join(" "),
})`;
const isTable = (s) => s.view === "table" && s.table && !s.feed && s.pressed === "feed=false table=true";
const isFeed = (s) => s.view === "feed" && s.feed && !s.table && s.pressed === "feed=true table=false";

/** Where focus goes over `steps` presses of Tab, as the view each stop sits in. */
async function tabStops(page, steps = 80) {
  await page.eval(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0)`);
  const stops = [];
  for (let i = 0; i < steps; i++) {
    await page.press("Tab");
    stops.push(await page.eval(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "body";
      return el.closest(".listing-table") ? "table" : el.closest(".listing-feed") ? "feed" : "chrome";
    })()`));
  }
  return stops;
}

try {
  await section("Desktop, the reader's choice of view:", {}, async (page) => {
    await page.goto(`${SITE}/`);
    await check("the feed shows by default and the table is out of the page", async () => isFeed(await page.eval(VIEW_STATE)) || page.eval(VIEW_STATE));
    await check("the switch is on screen", () => page.eval(shown(".view-switch")));
    await page.screenshot("desktop-feed-top");

    await page.click('[data-view-option="table"]');
    await check("choosing Table shows the table and hides the feed", async () => isTable(await page.eval(VIEW_STATE)) || page.eval(VIEW_STATE));
    await check("the choice is stored and the address stays clean",
      async () => (await page.eval(`localStorage.getItem("blog:view") + location.search`)) === "table");
    await page.screenshot("desktop-table");

    await page.reload();
    await check("after a reload the table was already chosen when the feed first existed — no flash",
      async () => (await page.eval("window.__viewWhenFeedAppeared")) === "table" && isTable(await page.eval(VIEW_STATE)));
    await page.goto(`${SITE}/?view=feed`);
    await check("?view=feed overrides the stored choice for that visit",
      async () => isFeed(await page.eval(VIEW_STATE)) && (await page.eval(`localStorage.getItem("blog:view")`)) === "table");
    await page.click('[data-view-option="feed"]');
    await page.click('[data-view-option="table"]');
    await page.reload();
    await check("choosing after a ?view= visit drops it from the address, so a reload agrees with the choice",
      async () => (await page.eval("location.search")) === "" && isTable(await page.eval(VIEW_STATE)));
    await page.goto(`${SITE}/?view=grid`);
    await check("an unknown ?view= falls back to the stored choice", async () => isTable(await page.eval(VIEW_STATE)));
    await page.goto(`${SITE}/tags/testing/`);
    await check("the choice carries to tag pages", async () => isTable(await page.eval(VIEW_STATE)));

    await page.goto(`${SITE}/`);
    await check("in table view, Tab never enters the hidden feed", async () => {
      const stops = await tabStops(page);
      return (!stops.includes("feed") && stops.includes("table")) || stops.join(",");
    });
    await page.eval(`document.querySelector('[data-view-option="feed"]').focus()`);
    await page.press("Enter");
    await check("Enter on Feed switches from the keyboard", async () => isFeed(await page.eval(VIEW_STATE)));
    await check("in feed view, Tab never enters the hidden table", async () => {
      const stops = await tabStops(page);
      return (!stops.includes("table") && stops.includes("feed")) || stops.join(",");
    });
    await page.eval(`document.querySelector('[data-view-option="table"]').focus()`);
    await page.press("Space");
    await check("Space on Table switches from the keyboard", async () => isTable(await page.eval(VIEW_STATE)));

    await page.click(".post-table tbody tr:nth-child(7) .post-table-date", { navigates: true });
    await check("clicking a row away from its links opens that post",
      async () => (await page.eval("location.pathname")) === "/latex-note/");
    await page.goto(`${SITE}/`);
    await page.click(".post-table tbody tr:nth-child(7) .post-table-tags a:last-child", { navigates: true });
    await check("a tag inside a row goes to the tag, not the post",
      async () => (await page.eval("location.pathname")) === "/tags/testing/");
  });

  await section("Desktop, posts sharing one page:", {}, async (page) => {
    await page.goto(`${SITE}/`);
    const order = await page.eval(`[...document.querySelectorAll(".listing-feed .feed-title")].map((h) => h.textContent)`);
    const rows = await page.eval(`[...document.querySelectorAll(".post-table tbody th")].map((h) => h.textContent)`);
    await check("feed and table list the same posts in the same order", () =>
      (JSON.stringify(order) === JSON.stringify(NEWEST_FIRST) && JSON.stringify(rows) === JSON.stringify(NEWEST_FIRST)) || { order, rows });

    await check("an image carrying its recorded size keeps its shape when scaled to the column", async () => {
      const box = await page.eval(`(() => {
        const img = document.createElement("img");
        img.src = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='4000' height='1000'/>");
        img.width = 4000;
        img.height = 1000;
        document.querySelector(".listing-feed .prose").prepend(img);
        const r = img.getBoundingClientRect();
        img.remove();
        return { width: Math.round(r.width), height: Math.round(r.height) };
      })()`);
      return (box.width < 4000 && Math.abs(box.width / box.height - 4) < 0.05) || box;
    });

    await page.click('a[href="#anchors-two--introduction"]');
    await page.settle();
    await check("an in-article link lands on its own article's heading, not the first post's", async () => {
      const where = await page.eval(`(() => {
        const target = document.getElementById(location.hash.slice(1));
        return { hash: location.hash, in: target && target.closest("article").querySelector(".feed-title").textContent,
          top: target && Math.round(target.getBoundingClientRect().top) };
      })()`);
      return (where.hash === "#anchors-two--introduction" && where.in === "Anchors, second" && where.top > 0 && where.top < 200) || where;
    });

    await page.click('a.heading-anchor[href="/anchors-two/#introduction"]', { navigates: true });
    await check("a section permalink opens the post's own page at that section", async () => {
      const where = await page.eval(`({ at: location.pathname + location.hash, found: !!document.getElementById("introduction") })`);
      return (where.at === "/anchors-two/#introduction" && where.found) || where;
    });
  });

  await section("Motion allowed, a tall article:", { height: 800 }, async (page) => {
    await page.goto(`${SITE}/`);
    const tall = `[...document.querySelectorAll(".feed-post")].pop()`;
    await check("the tall article is many screens high, so the reveal is tested where it is hardest", async () => {
      const h = await page.eval(`${tall}.getBoundingClientRect().height`);
      return h > 10 * 800 || h;
    });
    await check("an article below the fold waits hidden", async () => (await page.eval(`getComputedStyle(${tall}).opacity`)) === "0");
    await page.eval(`window.scrollTo({ top: ${tall}.getBoundingClientRect().top + window.scrollY - 600, behavior: "instant" })`);
    await sleep(1500);
    await check("…and appears once a sliver is on screen, though it can never be 10% visible",
      async () => (await page.eval(`getComputedStyle(${tall}).opacity`)) === "1");
  });

  await section("Motion allowed, a long post on its own page, on a phone:", { width: 390, height: 844 }, async (page) => {
    await page.goto(`${SITE}/tall/`);
    await sleep(1200);
    const body = `document.querySelector(".prose")`;
    await check("the body is many screens high", async () => {
      const h = await page.eval(`${body}.getBoundingClientRect().height`);
      return h > 10 * 844 || h;
    });
    await check("the body is visible on arrival, not waiting for a tenth of it to be on screen",
      async () => (await page.eval(`getComputedStyle(${body}).opacity`)) === "1");
  });

  await section("Reduced motion:", { reducedMotion: true }, async (page) => {
    await page.goto(`${SITE}/`);
    await check("every article is visible without any scrolling", async () => {
      const opacities = await page.eval(`[...document.querySelectorAll(".fade-up")].map((el) => getComputedStyle(el).opacity)`);
      return opacities.every((o) => o === "1") || opacities;
    });
    await page.screenshot("desktop-feed-full");
  });

  await section("Scripts off:", { noScript: true }, async (page) => {
    await page.goto(`${SITE}/`);
    await check("the feed is readable, and neither the switch nor the table appears", async () => {
      const state = await page.eval(`({
        js: document.documentElement.classList.contains("js"),
        feed: ${shown(".listing-feed")}, table: ${shown(".listing-table")}, switcher: ${shown(".view-switch")},
        hidden: [...document.querySelectorAll(".fade-up")].filter((el) => getComputedStyle(el).opacity !== "1").length,
      })`);
      return (!state.js && state.feed && !state.table && !state.switcher && state.hidden === 0) || state;
    });
  });

  await section("Storage refused:", { refuseStorage: true }, async (page) => {
    const before = scriptErrors.length;
    await page.goto(`${SITE}/`);
    await check("the page loads without a script error", async () =>
      (await page.eval(`(() => { try { localStorage; return "storage was not refused"; } catch (e) { return true; } })()`)) === true &&
      (scriptErrors.length === before || scriptErrors.slice(before)));
    await page.click('[data-view-option="table"]');
    await check("the switch still works, and the address carries the choice instead",
      async () => isTable(await page.eval(VIEW_STATE)) && (await page.eval("location.search")) === "?view=table");
    await page.reload();
    await check("so a reload keeps it", async () => isTable(await page.eval(VIEW_STATE)));
  });

  await section("Phone:", { width: 390, height: 844 }, async (page) => {
    const noSideways = async () => (await page.eval(`document.documentElement.scrollWidth <= window.innerWidth`)) ||
      page.eval(`({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`);
    await page.goto(`${SITE}/`);
    await check("the feed holds a code line and an equation wider than the phone, so the next check means something",
      () => page.eval(`[".listing-feed .code-block", ".listing-feed .katex-display"].every((s) => {
        const el = document.querySelector(s);
        return el && el.scrollWidth > window.innerWidth;
      })`));
    await check("the feed never scrolls the page sideways — wide content scrolls inside itself", noSideways);
    await page.screenshot("phone-feed");
    await page.click('[data-view-option="table"]');
    await check("the table never scrolls the page sideways", noSideways);
    await check("the table keeps its columns side by side, scrolling inside its frame if it must", async () => {
      const layout = await page.eval(`(() => {
        const heads = [...document.querySelectorAll(".post-table thead th")].map((th) => Math.round(th.getBoundingClientRect().top));
        return { sameRow: new Set(heads).size === 1, overflow: getComputedStyle(document.querySelector(".post-table-frame")).overflowX };
      })()`);
      return (layout.sameRow && layout.overflow === "auto") || layout;
    });
    await page.screenshot("phone-table");
    await page.goto(`${SITE}/tags/testing/`);
    await check("a tag page never scrolls the page sideways", noSideways);
  });

  await section("Pagination:", {}, async (page) => {
    await page.goto(`${PAGED}/`);
    const seen = [];
    let pages = 0;
    for (;;) {
      pages++;
      seen.push(...await page.eval(`[...document.querySelectorAll(".listing-feed .feed-title")].map((h) => h.textContent)`));
      if (!(await page.eval(`!!document.querySelector('.listing-feed a[rel="next"]')`)) || pages > 50) break;
      await page.click('.listing-feed a[rel="next"]', { navigates: true });
    }
    await check("following Older posts visits every post once, newest first", () =>
      (JSON.stringify(seen) === JSON.stringify(NEWEST_FIRST) && pages === NEWEST_FIRST.length) || { pages, seen });
    await page.screenshot("paged-last");
    await page.click('[data-view-option="table"]');
    await check("in table view the pager is gone and the table lists every post", async () => {
      const state = await page.eval(`({ pager: !!document.querySelector(".pager") && ${shown(".listing-feed")},
        rows: document.querySelectorAll(".post-table tbody tr").length })`);
      return (!state.pager && state.rows === NEWEST_FIRST.length) || state;
    });
  });

  await check("no script error was thrown on any page", () => scriptErrors.length === 0 || scriptErrors);
} finally {
  socket.close();
  chrome.kill();
  wholeServer.close();
  pagedServer.close();
  await sleep(200);
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
