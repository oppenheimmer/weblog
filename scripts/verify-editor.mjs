// Proves, in a real browser, what the editor says about the site (CLAUDE.md Step 7).
//
//   node scripts/verify-editor.mjs
//   node scripts/verify-editor.mjs --shots <dir>     # also save screenshots
//   CHROMIUM=/path/to/chrome node scripts/verify-editor.mjs
//
// Runs against the local stand-in in scripts/editor-harness.mjs: the real API
// handlers and editor page over an in-memory bucket, and a deployment whose
// build the script finishes by hand. Nothing leaves the machine.
import fs from "node:fs";
import path from "node:path";

import { startEditorHarness, ROOT, PASSWORD, sleep } from "./editor-harness.mjs";
import { newPostId, newRevisionId } from "../lib/server/drafts.mjs";

const SHOTS = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
const SAMPLE_PNG = fs.readFileSync(path.join(ROOT, "test/fixtures/assets/images/diagram.png")).toString("base64");
const IMPORT_DOCUMENT = [
  "---", 'title: "Imported writing flow"', "date: 2026-09-13",
  'description: "From a whole document"', "tags: [browser, editor]", "draft: true",
  "---", "Pasted source.", "",
].join("\n");
const TEX_BODY = "\\section{Imported}\n";

const harness = await startEditorHarness({ shots: SHOTS });
const { SITE, store, hooks, publisher, deployment, finishBuild, openPage, check, scriptErrors, serverErrors } = harness;

// A post migrated from the repository: published, live, and with no draft.
await publisher.publish({
  postId: newPostId(), revisionId: newRevisionId(1), version: 1,
  title: "Welcome", date: "2026-09-10", description: "", tags: [], format: "markdown",
  body: "Migrated, so it has no draft.", slug: "welcome",
});
await finishBuild();

// ---- checks -------------------------------------------------------------------

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

  console.log("\nWriting flow:");
  await page.eval(`(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", ${JSON.stringify(IMPORT_DOCUMENT)});
    document.getElementById("body").dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData: transfer,
    }));
  })()`);
  await check("pasting a full document imports safe frontmatter once and leaves hooks out", async () => {
    const imported = await page.eval(`({
      title: document.getElementById("title").value,
      description: document.getElementById("description").value,
      tags: document.getElementById("tags").value,
      body: document.getElementById("body").value,
      status: document.getElementById("attach-status").textContent,
    })`);
    return (imported.title === "Imported writing flow" && imported.description === "From a whole document" &&
      imported.tags === "browser, editor" && imported.body === "Pasted source.\n" &&
      imported.status === "Imported frontmatter and source.") || imported;
  });
  await check("the quiet period creates and autosaves the new draft", async () => {
    const status = await page.until(`/^autosaved · v1$/.test(document.getElementById("save-state").textContent)`);
    return status === true;
  });

  await page.eval(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(SAMPLE_PNG)}), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "flow-diagram.png", { type: "image/png" }));
    const input = document.getElementById("attach-input");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await check("attaching signs, uploads, verifies, and inserts the image", async () => {
    const attached = await page.until(`document.getElementById("attach-status").textContent === "Attached and inserted." && ({
      body: document.getElementById("body").value,
      count: document.querySelectorAll("#attachment-list .attachment").length,
    })`);
    return (attached.count === 1 && /!\[flow diagram\]\(attachment:\/\/a_[0-9a-f]{16}\)/.test(attached.body)) || attached;
  });
  await page.type("#attachment-list .attachment-alt input", "A hand-drawn flow");
  await page.click("#attachment-list .attachment-actions button");
  await check("editable alt text is used by Insert", async () => {
    const body = await page.eval(`document.getElementById("body").value`);
    return /!\[A hand-drawn flow\]\(attachment:\/\/a_[0-9a-f]{16}\)/.test(body) || body;
  });

  await page.eval(`(() => {
    const body = document.getElementById("body");
    body.value += "\\n![missing](attachment://a_0000000000000000)" +
      "\\n" + String.fromCharCode(96) + "![example](attachment://a_0000000000000001)" + String.fromCharCode(96);
    body.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await check("an unresolved reference is offered for relinking", async () =>
    (await page.eval(`!document.getElementById("relink-tools").hidden &&
      document.getElementById("unresolved-reference").value === "image:a_0000000000000000"`)) === true);
  await check("beside Publish, the missing reference is named before Publish is pressed", async () => {
    const readiness = await page.until(`document.getElementById("publish-readiness").dataset.state === "error" && ({
      text: document.getElementById("publish-readiness").textContent })`);
    return /a_0000000000000000/.test(readiness.text) || readiness;
  });
  await page.click("#relink");
  await check("relink replaces the missing id with a verified attachment", async () => {
    const result = await page.eval(`({ body: document.getElementById("body").value,
      hidden: document.getElementById("relink-tools").hidden })`);
    return (!result.body.includes("a_0000000000000000") &&
      result.body.includes("a_0000000000000001") && result.hidden) || result;
  });
  await check("once relinked, Publish is said to be ready, at its address, with its one image", async () => {
    const text = await page.until(`document.getElementById("publish-readiness").dataset.state === "ready" &&
      document.getElementById("publish-readiness").textContent`);
    return text === "Ready to publish at /imported-writing-flow/ with 1 image." || text;
  });
  await page.click("#preview-toggle");
  await check("the attached draft previews without a publication error", async () => {
    const preview = await page.until(`document.getElementById("preview-state").textContent === "up to date" && ({
      srcdoc: document.getElementById("preview-frame").srcdoc,
      diagnostics: document.getElementById("diagnostics").textContent,
    })`);
    return (preview.srcdoc.includes("Pasted source.") && preview.srcdoc.includes("/local-download/") &&
      preview.srcdoc.includes('alt="A hand-drawn flow"') &&
      preview.diagnostics === "") || preview;
  });
  await page.click("#save");
  await page.until(`/^saved · v\\d+$/.test(document.getElementById("save-state").textContent)`);
  await page.reload();
  await page.until(`[...document.querySelectorAll("#draft-list button")].some((b) => b.textContent.includes("Imported writing flow"))`);
  await page.eval(`[...document.querySelectorAll("#draft-list button")]
    .find((button) => button.textContent.includes("Imported writing flow")).click()`);
  await check("after reload, the saved writing flow opens with its source and attachment", async () => {
    // The title is written before the post's attachments load; the saved
    // status is written after both lists have. Sampling on the title alone lost
    // that race on a CI runner.
    const reopened = await page.until(`document.getElementById("title").value === "Imported writing flow" &&
      /^saved · v\\d+$/.test(document.getElementById("save-state").textContent) && ({
      body: document.getElementById("body").value,
      attachments: document.querySelectorAll("#attachment-list .attachment").length,
    })`);
    return (reopened.body.includes("Pasted source.") && reopened.attachments === 1) || reopened;
  });
  await page.eval(`document.getElementById("discard").click()`);
  await page.until(`document.getElementById("title").value === ""`);

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
  await check("a locked address is named beside Publish before it is pressed", async () => {
    const text = await page.until(`document.getElementById("publish-readiness").dataset.state === "error" &&
      document.getElementById("publish-readiness").textContent`);
    return /cannot change while it is published/.test(text) || text;
  });
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
    await page.until(`document.getElementById("publication-rebuild").getAttribute("aria-disabled") === "true"`);
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
        busyBefore: b.getAttribute("aria-disabled") === "true" };
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
      busy: document.getElementById("publication-rebuild").getAttribute("aria-disabled") === "true",
      error: document.getElementById("editor-error").textContent,
    })`);
    return (visible.offered && visible.panelHidden && hit === "publication-rebuild" &&
      hooks.length === before + 1 && after.busy && !after.error &&
      /Rebuilding/.test(after.note)) || { visible, hit, after, fired: hooks.length - before };
  });

  console.log("\nEditing a publication-only post:");
  await page.eval(`[...document.querySelectorAll("#publication-list button")]
    .find((button) => button.textContent.includes("Welcome")).click()`);
  await check("a post with no draft offers the selected stored revision as an editable draft", async () => {
    const offered = await page.until(`!document.getElementById("publication").hidden && ({
      branch: !document.getElementById("publication-branch").hidden,
      revision: document.getElementById("publication-revision").value,
    })`);
    return (offered.branch && /^r_000001_/.test(offered.revision)) || offered;
  });
  await page.eval(`document.getElementById("publication-branch").click()`);
  await check("Edit as draft keeps the post identity and loads the published text", async () => {
    // loadDraft fills the form before awaiting attachments and the draft list.
    // Only branchShown's final status means the panel has finished refreshing.
    const draft = await page.until(`document.getElementById("save-state").textContent ===
      "draft created from published revision" && ({
      title: document.getElementById("title").value,
      body: document.getElementById("body").value,
      status: document.getElementById("save-state").textContent,
      branchHidden: document.getElementById("publication-branch").hidden,
    })`);
    return (draft.title === "Welcome" && draft.body === "Migrated, so it has no draft." &&
      draft.branchHidden) || draft;
  });

  await page.eval(`(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify("---\ntitle: From TeX\ndate: 2026-09-13\n---\n\\section{Imported}\n")}],
      "from-file.tex", { type: "text/x-tex" }));
    const input = document.getElementById("import-source-input");
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await check("a .tex source file imports metadata and switches the source format", async () => {
    const imported = await page.until(`document.getElementById("title").value === "From TeX" && ({
      format: document.getElementById("format").value,
      body: document.getElementById("body").value,
      status: document.getElementById("attach-status").textContent,
    })`);
    return (imported.format === "latex" && imported.body === TEX_BODY &&
      imported.status === "Imported frontmatter and source.") || imported;
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
  await harness.shutdown();
}

harness.finish();
