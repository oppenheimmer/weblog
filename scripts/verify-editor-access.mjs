// Proves, in a real browser, that the editor works without a file picker, a
// mouse or a screen to look at (CLAUDE.md Step 5, Step 9).
//
//   node scripts/verify-editor-access.mjs
//   CHROMIUM=/path/to/chrome node scripts/verify-editor-access.mjs
//
// Runs against the local stand-in in scripts/editor-harness.mjs. Every input
// here is one the browser itself trusts: a file dragged from disk, an image on
// the clipboard pasted with Ctrl+V, key presses through the input pipeline. A
// synthetic DOM event would prove only that a listener runs when called.
//
// What an assistive technology reads is taken from Chromium's own
// accessibility tree, not inferred from markup.
import fs from "node:fs";
import path from "node:path";

import { startEditorHarness, ROOT, PASSWORD, sleep } from "./editor-harness.mjs";
import { cannotRun } from "./chromium.mjs";
import { createDraftStore, newPostId, newRevisionId } from "../lib/server/drafts.mjs";
import { identify } from "../lib/media.mjs";

const DIAGRAM = path.join(ROOT, "test/fixtures/assets/images/diagram.png");
const TITLE = "Keyboard and assistive checks";

const harness = await startEditorHarness();
const { SITE, store, hooks, publisher, finishBuild, openPage, check, scriptErrors, serverErrors, logLines } = harness;

// The roles a person can operate. Each needs a name, or a screen reader
// announces "button" and nothing else.
const OPERABLE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "spinbutton", "slider", "switch", "tab", "menuitem", "date", "Iframe",
]);

const attachmentCount = `document.querySelectorAll("#attachment-list .attachment").length`;

// WCAG contrast, measured from what Chromium computed: every visible run of
// text, form value and placeholder, its colour composited over the backgrounds
// behind it. 4.5:1, or 3:1 for large text. Disabled and busy controls are
// exempt, as WCAG exempts inactive components; the preview frame is the
// public site's own styling. Anything over an image cannot be measured and is
// counted rather than guessed.
const CONTRAST = `(() => {
  const parse = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a), a: 1,
  });
  const luminance = ({ r, g, b }) => [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const background = (el) => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return null;
      const color = parse(style.backgroundColor);
      if (color && color.a > 0) layers.push(color);
      if (color && color.a === 1) break;
    }
    return layers.reverse().reduce((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 });
  };
  const opacity = (el) => {
    let value = 1;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
    return value;
  };
  const exempt = (el) => el.closest("iframe, svg, [aria-disabled='true'], :disabled, [hidden]");
  const measure = (el, colorValue, sample) => {
    const style = getComputedStyle(el);
    const bg = background(el);
    if (!bg) return { skipped: true };
    const fg = parse(colorValue);
    const text = over({ ...fg, a: fg.a * opacity(el) }, bg);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const value = ratio(text, bg);
    return { sample, ratio: Math.round(value * 100) / 100, need: large ? 3 : 4.5, ok: value >= (large ? 3 : 4.5) };
  };
  const results = [];
  let skipped = 0;
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!node.textContent.trim() || seen.has(el) || exempt(el)) continue;
    if (!el.checkVisibility({ visibilityProperty: true }) || el.getBoundingClientRect().width === 0) continue;
    seen.add(el);
    const result = measure(el, getComputedStyle(el).color, node.textContent.trim().slice(0, 40));
    if (result.skipped) skipped++; else results.push(result);
  }
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (exempt(el) || !el.checkVisibility() || el.type === "file") continue;
    if (el.value) results.push(measure(el, getComputedStyle(el).color, "value of #" + el.id));
    if (el.placeholder && !el.value) results.push(measure(el, getComputedStyle(el, "::placeholder").color, "placeholder of #" + el.id));
  }
  return { failing: results.filter((r) => r && !r.ok), measured: results.length, skipped };
})()`;

/** Whether the page scrolls sideways at a given width. */
const reflowAt = async (page, width) => {
  await page.resize(width, 800);
  await sleep(300);
  const fit = await page.eval(`({ scroll: document.documentElement.scrollWidth, width: innerWidth })`);
  await page.resize(1440, 900);
  return fit;
};
const active = `(document.activeElement && (document.activeElement.id || document.activeElement.tagName))`;

let page;
try {
  page = await openPage();
  const { call } = page;
  await call("Accessibility.enable");
  await call("DOM.enable");

  /** What Chromium's accessibility tree says about one element. */
  async function ax(selector) {
    const { root } = await call("DOM.getDocument", { depth: 0 });
    const { nodeId } = await call("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) return null;
    const { nodes } = await call("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    const node = nodes.find((n) => !n.ignored) ?? nodes[0];
    return { role: node?.role?.value ?? null, name: node?.name?.value ?? "", description: node?.description?.value ?? "" };
  }

  /** Count changes to an element's content from now on, as a live region would hear them. */
  const watchMutations = (id) => page.eval(`(() => {
    window.__mutations = window.__mutations || {};
    window.__mutations[${JSON.stringify(id)}] = 0;
    new MutationObserver((records) => { window.__mutations[${JSON.stringify(id)}] += records.length; })
      .observe(document.getElementById(${JSON.stringify(id)}), { childList: true, characterData: true, subtree: true });
  })()`);
  const mutations = (id) => page.eval(`window.__mutations[${JSON.stringify(id)}]`);

  /** Focus a text field with the caret at its end, as a person clicking into it would type. */
  const focusEnd = (id) => page.eval(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  })()`);

  // ---- signing in -------------------------------------------------------------
  console.log("\nSigning in by keyboard:");
  await page.goto(`${SITE}/login/`);
  await check("the password field has focus when the page opens", async () =>
    (await page.until(`document.activeElement?.id === "password"`)) === true);
  await page.insertText("not the password");
  await page.press("Enter");
  await check("a refused password is announced as an alert, and the field keeps focus to try again", async () => {
    await page.until(`document.getElementById("login-error").textContent.length > 0`);
    await page.until(`!document.getElementById("login-submit").disabled`);
    const node = await ax("#login-error");
    const focus = await page.eval(active);
    return (node.role === "alert" && focus === "password") || { node, focus };
  });
  await check("the sign-in page's text meets WCAG AA contrast", async () => {
    const result = await page.eval(CONTRAST);
    return (result.failing.length === 0 && result.measured > 0) || result;
  });
  await check("the sign-in page reflows at 320 CSS pixels without scrolling sideways", async () => {
    const fit = await reflowAt(page, 320);
    return fit.scroll <= fit.width || fit;
  });
  await page.eval(`document.getElementById("password").select()`);
  await page.insertText(PASSWORD); // the refused text is selected, so this replaces it
  await page.press("Enter");
  await page.until(`location.pathname === "/editor/" && document.getElementById("save-state").textContent === "not saved"`);

  // ---- attaching without the picker ---------------------------------------------
  console.log("\nAttaching without the file picker:");
  await focusEnd("title");
  await page.insertText(TITLE);
  await focusEnd("body");
  await page.insertText("Opening line.");

  const bodyBox = await page.boxOf(`document.getElementById("body")`);
  const drag = { items: [], files: [DIAGRAM], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await call("Input.dispatchDragEvent", { type, x: bodyBox.x, y: bodyBox.y, data: drag });
  }
  await check("an image dragged from disk onto the body is uploaded, verified and inserted on its own line", async () => {
    const result = await page.until(`document.getElementById("attach-status").textContent === "Attached and inserted." &&
      ${attachmentCount} === 1 && ({ body: document.getElementById("body").value })`);
    const blobs = (await store.listAll("attachments/")).filter((o) => o.key.includes("/files/"));
    const stored = blobs.length === 1 ? (await store.get(blobs[0].key)).body : null;
    return (Boolean(stored?.equals(fs.readFileSync(DIAGRAM))) &&
      /\n!\[diagram\]\(attachment:\/\/a_[0-9a-f]{16}\)\n?/.test(result.body)) || { body: result.body, blobs: blobs.length };
  });

  // A real paste: the image goes on the clipboard, and Ctrl+V asks the browser
  // to paste it into the focused textarea. Whether this browser can hold an
  // image on its clipboard at all is a question about the environment.
  await page.send("Browser.grantPermissions", {
    origin: SITE, browserContextId: page.browserContextId,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  const clipboard = await page.eval(`(async () => {
    try {
      const bytes = Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(DIAGRAM).toString("base64"))}), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
      return "ok";
    } catch (err) { return err.message; }
  })()`);
  if (clipboard !== "ok") cannotRun("this browser cannot put an image on its clipboard", clipboard);

  await focusEnd("body");
  await page.press("v", { ctrl: true, commands: ["paste"] });
  await check("an image pasted from the clipboard is uploaded, verified and inserted", async () => {
    const result = await page.until(`${attachmentCount} === 2 &&
      document.getElementById("attach-status").textContent === "Attached and inserted." &&
      ({ body: document.getElementById("body").value })`);
    const blobs = (await store.listAll("attachments/")).filter((o) => o.key.includes("/files/image"));
    const stored = blobs.length === 1 ? (await store.get(blobs[0].key)).body : null;
    const found = stored ? identify(stored, { kind: "image" }) : null;
    const references = result.body.match(/attachment:\/\/a_[0-9a-f]{16}/g) ?? [];
    return (found?.ok && found.mediaType === "image/png" && references.length === 2) ||
      { found, references: references.length, blobs: blobs.map((b) => b.key) };
  });

  await page.eval(`navigator.clipboard.writeText("plain words")`);
  await page.press("v", { ctrl: true, commands: ["paste"] });
  await check("pasting ordinary text still just pastes text", async () => {
    const result = await page.until(`document.getElementById("body").value.endsWith("plain words") && ({
      attachments: ${attachmentCount},
    })`);
    return result.attachments === 2 || result;
  });

  // ---- names --------------------------------------------------------------------
  console.log("\nWhat a screen reader is told:");
  await check("every control has an accessible name", async () => {
    const { nodes } = await call("Accessibility.getFullAXTree");
    const unnamed = [];
    for (const node of nodes) {
      if (node.ignored || !OPERABLE.has(node.role?.value)) continue;
      if (String(node.name?.value ?? "").trim()) continue;
      const { node: dom } = await call("DOM.describeNode", { backendNodeId: node.backendDOMNodeId });
      const attrs = Object.fromEntries((dom.attributes ?? []).reduce((pairs, value, i, all) =>
        (i % 2 ? pairs : [...pairs, [value, all[i + 1]]]), []));
      unnamed.push(`${node.role.value} <${dom.nodeName.toLowerCase()}${attrs.id ? `#${attrs.id}` : ""}>`);
    }
    return unnamed.length === 0 || unnamed;
  });
  await check("the body is named Body, and no label wraps a second control", async () => {
    const body = await ax("#body");
    const crowded = await page.eval(`[...document.querySelectorAll("label")]
      .filter((label) => label.querySelectorAll("button, input, select, textarea, a[href]").length > 1)
      .map((label) => label.textContent.trim().replace(/\\s+/g, " "))`);
    return (body.name === "Body" && crowded.length === 0) || { body, crowded };
  });
  await check("each attachment's buttons say which file they act on", async () => {
    const names = [];
    const count = await page.eval(attachmentCount);
    for (let i = 1; i <= count; i++) {
      const file = await page.eval(`document.querySelector("#attachment-list .attachment:nth-child(${i}) .attachment-name").textContent`);
      for (const button of ["button:nth-of-type(1)", "button:nth-of-type(2)"]) {
        const node = await ax(`#attachment-list .attachment:nth-child(${i}) .attachment-actions ${button}`);
        names.push({ file, name: node.name });
      }
    }
    const vague = names.filter(({ file, name }) => !name.includes(file));
    // Two files, so a list where every button is just "Insert" or "Remove" fails.
    return (names.length === 4 && vague.length === 0) || names;
  });
  await check("Publish is described by what it will publish", async () => {
    await page.until(`document.getElementById("publish-readiness").dataset.state === "ready"`);
    const node = await ax("#publish");
    return node.description === "Ready to publish at /keyboard-and-assistive-checks/ with 2 images." || node;
  });
  await check("the page has exactly one top-level heading", async () =>
    (await page.eval(`document.querySelectorAll("h1").length`)) === 1);
  // ---- the keyboard -----------------------------------------------------------
  console.log("\nThe keyboard:");
  await check("Tab reaches every visible control, and each shows where focus is", async () => {
    const expected = await page.eval(`[...document.querySelectorAll(
      "a[href], button, input, select, textarea, iframe, [tabindex]:not([tabindex='-1'])")]
      .filter((el) => !el.disabled && el.type !== "hidden" && el.checkVisibility())
      .map((el) => el.id || el.getAttribute("aria-label") || el.querySelector(".draft-title")?.textContent ||
        el.textContent.trim() || el.tagName)`);
    await page.eval(`(() => { document.activeElement?.blur(); window.scrollTo(0, 0); })()`);
    const reached = new Map();
    const unseen = [];
    for (let i = 0; i < 160; i++) {
      await page.press("Tab");
      const focus = await page.eval(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const ring = (style.outlineStyle !== "none" && style.outlineWidth !== "0px") || style.boxShadow !== "none";
        return {
          // A list button's text carries its save time, which an autosave
          // during the walk changes; its title is what identifies it.
          key: el.id || el.getAttribute("aria-label") || el.querySelector(".draft-title")?.textContent ||
            el.textContent.trim() || el.tagName,
          visible: el.checkVisibility() && el.getBoundingClientRect().width > 0,
          ring,
        };
      })()`);
      if (!focus) continue;
      if (!reached.has(focus.key)) reached.set(focus.key, focus);
      if (!focus.visible || !focus.ring) unseen.push(focus);
    }
    const missed = expected.filter((key) => !reached.has(key));
    return (missed.length === 0 && unseen.length === 0) || { missed, unseen: unseen.slice(0, 5) };
  });

  await focusEnd("title");
  await page.insertText(" by keyboard");
  await page.eval(`document.getElementById("save").focus()`);
  await page.press("Enter");
  await check("Enter on Save saves, and focus stays on Save", async () => {
    await page.until(`/^saved · v\\d+$/.test(document.getElementById("save-state").textContent)`);
    await sleep(200);
    return (await page.eval(active)) === "save" || await page.eval(active);
  });

  await focusEnd("body");
  await page.insertText(" More.");
  await page.press("s", { ctrl: true });
  await check("Ctrl+S saves from the body and leaves the cursor where it was", async () => {
    await page.until(`/^saved · v\\d+$/.test(document.getElementById("save-state").textContent)`);
    const where = await page.eval(`(() => { const b = document.getElementById("body");
      return { focus: document.activeElement === b, caret: b.selectionStart === b.value.length }; })()`);
    return (where.focus && where.caret) || where;
  });

  console.log("\nWhat is announced:");
  await watchMutations("save-state");
  await focusEnd("title");
  for (const letter of "abcdefgh") await page.insertText(letter);
  await check("typing changes the save status once, not once per key", async () => {
    await sleep(300); // inside the autosave's quiet period
    const count = await mutations("save-state");
    return count <= 1 || count;
  });
  await page.until(`/^autosaved · v\\d+$/.test(document.getElementById("save-state").textContent)`);

  await page.eval(`document.getElementById("publish").focus()`);
  let before = hooks.length;
  await page.press("Enter");
  await check("Enter on Publish publishes once, and focus stays on Publish", async () => {
    await page.until(`document.getElementById("save-state").textContent.startsWith("published") &&
      !document.getElementById("publication").hidden`);
    await sleep(200);
    const focus = await page.eval(active);
    return (focus === "publish" && hooks.length === before + 1) || { focus, hooks: hooks.length - before };
  });

  await page.until(`document.getElementById("publication-chip").textContent === "Not live yet"`);
  await watchMutations("publication-summary");
  await check("the site panel announces nothing while nothing changes", async () => {
    // The panel checks the site after 4 seconds, then 8: two checks, no news.
    await sleep(13_000);
    const count = await mutations("publication-summary");
    return count === 0 || count;
  });
  await finishBuild();
  await check("and does announce when the site catches up", async () => {
    await page.until(`document.getElementById("publication-chip").textContent === "Live"`, 45_000);
    const count = await mutations("publication-summary");
    return count > 0 || count;
  });

  await page.eval(`document.getElementById("preview-toggle").focus()`);
  await page.press("Enter");
  await page.until(`document.getElementById("preview-state").textContent === "up to date"`);
  await check("status messages are live regions, and errors are alerts", async () => {
    const roles = {};
    for (const id of ["save-state", "attach-status", "preview-state", "publication-summary", "rebuild-note", "editor-published"]) {
      roles[id] = (await ax(`#${id}`))?.role;
    }
    roles["editor-error"] = (await ax("#editor-error"))?.role;
    const wrong = Object.entries(roles).filter(([id, role]) => role !== (id === "editor-error" ? "alert" : "status"));
    return wrong.length === 0 || roles;
  });

  await page.press("Enter"); // close the preview again

  await page.eval(`document.getElementById("publication-rebuild").focus()`);
  before = hooks.length;
  await page.press("Enter");
  await check("Rebuild site keeps focus while it pauses, and a second Enter does nothing", async () => {
    await page.until(`/Rebuilding/.test(document.getElementById("rebuild-note").textContent)`);
    await page.press("Enter");
    await sleep(500);
    const focus = await page.eval(active);
    return (focus === "publication-rebuild" && hooks.length === before + 1) || { focus, hooks: hooks.length - before };
  });

  console.log("\nSeeing it:");
  await check("the editor's text meets WCAG AA contrast, with a post, its attachments and its panel on screen", async () => {
    const result = await page.eval(CONTRAST);
    return (result.failing.length === 0 && result.measured > 20) || result;
  });
  await check("the editor reflows at 320 CSS pixels without scrolling sideways", async () => {
    const fit = await reflowAt(page, 320);
    return fit.scroll <= fit.width || fit;
  });

  await page.eval(`document.getElementById("slug").focus()`);
  await page.eval(`(() => { const s = document.getElementById("slug"); s.select(); })()`);
  await page.insertText("api");
  await page.eval(`document.getElementById("publish").focus()`);
  await page.press("Enter");
  await check("a refused field is marked invalid, tied to the error, and given focus", async () => {
    await page.until(`document.getElementById("editor-error").textContent.includes("reserved")`);
    const slug = await page.eval(`(() => { const s = document.getElementById("slug"); return {
      invalid: s.getAttribute("aria-invalid"),
      describedBy: s.getAttribute("aria-describedby") || "",
      focus: document.activeElement === s,
    }; })()`);
    return (slug.invalid === "true" && slug.describedBy.split(/\s+/).includes("editor-error") && slug.focus) || slug;
  });
  await page.eval(`document.getElementById("slug").select()`);
  await page.insertText("keyboard-and-assistive-checks");
  await check("and editing the field clears the mark", async () =>
    (await page.eval(`document.getElementById("slug").getAttribute("aria-invalid")`)) !== "true");
  await page.eval(`document.getElementById("save").focus()`);
  await page.press("Enter");
  await page.until(`/^saved · v\\d+$/.test(document.getElementById("save-state").textContent)`);

  // ---- the conflict dialog ------------------------------------------------------
  console.log("\nThe conflict dialog:");
  const drafts = createDraftStore(store);
  const mine = (await drafts.list()).find((draft) => draft.title.includes(TITLE));
  const current = await drafts.get(mine.postId);
  await drafts.save(mine.postId, { body: "Saved elsewhere." }, current.etag);

  await focusEnd("body");
  await page.insertText(" Local change.");
  await page.eval(`document.getElementById("save").focus()`);
  await page.press("Enter");
  await check("a conflict opens the dialog with focus on its first choice", async () =>
    (await page.until(`!document.getElementById("conflict").hidden && ${active}`)) === "conflict-keep");
  await check("Tab and Shift+Tab stay inside the dialog", async () => {
    const seen = [];
    for (const shift of [false, false, true, true]) {
      await page.press("Tab", { shift });
      seen.push(await page.eval(active));
    }
    return JSON.stringify(seen) === JSON.stringify(["conflict-theirs", "conflict-keep", "conflict-theirs", "conflict-keep"]) || seen;
  });
  await page.press("Escape");
  await check("Escape closes it without choosing, and focus returns to Save", async () => {
    const after = await page.until(`document.getElementById("conflict").hidden && ({
      focus: ${active}, status: document.getElementById("save-state").textContent })`);
    const stored = (await drafts.get(mine.postId)).draft.body;
    return (after.focus === "save" && after.status === "conflict" && stored === "Saved elsewhere.") || { ...after, stored };
  });
  await page.press("Enter");
  await page.until(`!document.getElementById("conflict").hidden`);
  await page.press("Tab");
  await page.press("Enter");
  await check("choosing loads the saved text, and focus returns to Save", async () => {
    const after = await page.until(`document.getElementById("conflict").hidden && ({
      focus: ${active}, body: document.getElementById("body").value })`);
    return (after.focus === "save" && after.body === "Saved elsewhere.") || after;
  });

  // ---- panel actions ---------------------------------------------------------
  console.log("\nPanel actions:");
  // A post with no draft, as migration left one, published from elsewhere. The
  // editor's list picks it up on its next refresh, which Unpublish performs.
  await publisher.publish({
    postId: newPostId(), revisionId: newRevisionId(1), version: 1, title: "Branch me",
    date: "2026-09-01", description: "", tags: [], format: "markdown", body: "Published elsewhere.", slug: "branch-me",
  });
  await page.eval(`document.getElementById("publication-unpublish").focus()`);
  await page.press("Enter");
  await check("Unpublish hides its own button, and focus moves to Put back rather than the page", async () => {
    await page.until(`document.getElementById("publication-chip").textContent === "Coming down"`);
    await sleep(200);
    return (await page.eval(active)) === "publication-rollback" || await page.eval(active);
  });

  await page.eval(`[...document.querySelectorAll("#publication-list button")]
    .find((button) => button.textContent.includes("Branch me")).focus()`);
  await page.press("Enter");
  await page.until(`!document.getElementById("publication-branch").hidden &&
    document.getElementById("publication-summary").textContent.includes("Branch me")`);
  await page.eval(`document.getElementById("publication-branch").focus()`);
  await page.press("Enter");
  await check("Edit as draft hides its own button, and focus moves to the draft it opened", async () => {
    await page.until(`document.getElementById("save-state").textContent === "draft created from published revision"`);
    await sleep(200);
    return (await page.eval(active)) === "title" || await page.eval(active);
  });

  console.log("\nComing back to the tab:");
  await page.eval(`document.getElementById("new-post").focus()`);
  await page.press("Enter");
  await focusEnd("title");
  await page.insertText("Claimed elsewhere");
  await focusEnd("body");
  await page.insertText("Words.");
  await page.until(`document.getElementById("publish-readiness").textContent ===
    "Ready to publish at /claimed-elsewhere/ with no attachments."`);
  // Another tab takes the address while this one is in the background. Focus
  // emulation, which the clipboard needed, keeps a page visible whatever tab
  // is in front, so it goes first.
  await call("Emulation.setFocusEmulationEnabled", { enabled: false });
  const { targetId: other } = await page.send("Target.createTarget", { url: "about:blank", browserContextId: page.browserContextId });
  await page.send("Target.activateTarget", { targetId: other });
  await page.until(`document.visibilityState === "hidden"`);
  await publisher.publish({
    postId: newPostId(), revisionId: newRevisionId(1), version: 1, title: "Claimed elsewhere",
    date: "2026-09-01", description: "", tags: [], format: "markdown", body: "First.", slug: "claimed-elsewhere",
  });
  await page.send("Target.activateTarget", { targetId: page.targetId });
  await check("returning to the tab re-checks Publish, with no edit, and names the address now taken", async () => {
    const text = await page.until(`document.visibilityState === "visible" &&
      document.getElementById("publish-readiness").dataset.state === "error" &&
      document.getElementById("publish-readiness").textContent`);
    return /already used by another post/.test(text) || text;
  });
  await page.send("Target.closeTarget", { targetId: other });

  // ---- signing out --------------------------------------------------------------
  console.log("\nSigning out:");
  const csrf = await page.eval(`fetch("/api/auth/session/").then((r) => r.json()).then((s) => s.csrfToken)`);
  const { cookies } = await page.send("Storage.getCookies", { browserContextId: page.browserContextId });
  const session = cookies.find((cookie) => cookie.name.startsWith("weblog_session"));
  await focusEnd("title");
  await page.insertText(" unsaved");
  await page.eval(`document.getElementById("logout").focus()`);
  const dialogs = page.dialogs.length;
  await page.press("Enter");
  await check("Sign out asks first when there are unsaved changes, then lands on sign-in with focus ready", async () => {
    await page.until(`location.pathname === "/login/" && document.activeElement?.id === "password"`);
    return /unsaved changes/.test(page.dialogs.slice(dialogs).join(" ")) || page.dialogs.slice(dialogs);
  });
  await check("the old session cookie opens nothing any more", async () => {
    if (!session) return "no session cookie was found to replay";
    const cookie = `${session.name}=${session.value}`;
    const state = await (await fetch(`${SITE}/api/auth/session/`, { headers: { cookie } })).json();
    const drafts = (await fetch(`${SITE}/api/drafts/`, { headers: { cookie } })).status;
    const editor = await fetch(`${SITE}/editor/`, { headers: { cookie }, redirect: "manual" });
    return (state.authenticated === false && drafts === 401 && editor.status === 302 &&
      editor.headers.get("location") === "/login/") || { state, drafts, editor: editor.status };
  });
  await page.goto(`${SITE}/editor/`);
  await check("and the browser is sent back to sign in", async () =>
    (await page.until(`location.pathname === "/login/"`)) === true);

  await check("no request log from the whole session carries a secret or the draft's text", async () => {
    // Every line the server wrote while a person signed in with a password,
    // uploaded on signed URLs and typed a draft.
    const all = logLines.join("\n");
    const leaked = [
      ["the password", PASSWORD], ["the refused password", "not the password"],
      ["the session cookie", session?.value], ["the CSRF token", csrf],
      ["a signed upload URL", "local-upload"], ["the draft's text", "Opening line."], ["pasted text", "plain words"],
    ].filter(([, secret]) => secret && all.includes(secret)).map(([what]) => what);
    return (logLines.length > 50 && Boolean(session?.value) && Boolean(csrf) && leaked.length === 0) ||
      { lines: logLines.length, leaked };
  });
  await check("no script error was thrown", () => scriptErrors.length === 0 || scriptErrors);
  await check("no request failed inside the server", () => serverErrors.length === 0 || serverErrors);
} finally {
  await harness.shutdown();
}

harness.finish();
