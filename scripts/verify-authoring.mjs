// Browser proof for retained history, publication review and portable exports.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startEditorHarness, PASSWORD, sleep } from "./editor-harness.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";
import { createUploads } from "../lib/server/uploads.mjs";
import { keys } from "../lib/server/keys.mjs";
const harness = await startEditorHarness();
const { SITE, store, openPage, check, scriptErrors, serverErrors, publisher, finishBuild } = harness;
const drafts = createDraftStore(store);
const first = await drafts.create({ title: "Authoring tools", date: "2026-10-29", body: "Original text" });
const second = await drafts.save(first.draft.postId, { body: 'Changed text\n<script>window.historyProbe=true</script>' }, first.etag);
const image = fs.readFileSync(new URL("../test/fixtures/media/sample-7x11.png", import.meta.url));
const uploads = createUploads(store, { signPut: async () => "https://unused.test" });
const signed = await uploads.sign({ postId: first.draft.postId, name: "image.png", size: image.length, type: "image/png" });
await store.put(keys.upload(first.draft.postId, signed.uploadId, "file"), image);
await uploads.complete({ postId: first.draft.postId, uploadId: signed.uploadId });
let page;
try {
  page = await openPage();
  await page.goto(`${SITE}/login/`);
  await page.type("#password", PASSWORD);
  await page.click("#login-submit");
  await page.until('location.pathname === "/editor/"');
  await page.clickText("#draft-list button", "Authoring tools");
  await page.until('document.getElementById("body").value.startsWith("Changed text")');
  await page.click("#history-panel summary");
  await page.until('document.getElementById("history-revision").options.length === 2');
  await page.eval(`document.getElementById("history-revision").value = ${JSON.stringify(first.draft.revisionId)}`);
  await page.click("#history-compare");
  await check("history compares real retained source without executing its markup", async () => {
    await page.until('!document.getElementById("comparison").hidden');
    return await page.eval('document.getElementById("comparison-body").textContent.includes("Changed text") && !window.historyProbe && document.querySelectorAll("#comparison-body script").length === 0');
  });
  await page.click("#history-restore");
  await check("restore creates a new save and leaves the replaced revision readable", async () => {
    await page.until('document.getElementById("body").value === "Original text" && document.getElementById("save-state").textContent.includes("restored")');
    const current = await drafts.get(first.draft.postId);
    assert.equal(current.draft.version, 3);
    assert.equal((await drafts.getRevision(first.draft.postId, second.draft.revisionId)).body, second.draft.body);
    return true;
  });
  const live = (await drafts.get(first.draft.postId)).draft;
  await page.type("#checkpoint-name", "Before restructuring");
  await page.click("#checkpoint-create");
  await check("a named checkpoint captures the saved source with its chosen label", async () => {
    await page.until('document.getElementById("checkpoint-note").textContent.includes("Saved")');
    return (await drafts.checkpoints(first.draft.postId))[0]?.name === "Before restructuring";
  });
  await publisher.publish(live);
  await finishBuild();
  const latest = await drafts.save(live.postId, { body: "Latest publication" }, (await drafts.get(live.postId)).etag);
  await publisher.publish(latest.draft);
  await page.click("#review-changes");
  await check("review compares against the latest publication", async () => {
    await page.until('document.getElementById("comparison-label").textContent.includes("Latest publication")');
    return await page.eval('document.getElementById("comparison-body").textContent.includes("Latest publication")');
  });
  await page.eval('document.getElementById("review-baseline").value = "live"');
  await page.click("#review-changes");
  await check("live comparison follows the served manifest rather than the newer R2 publication", async () => {
    await page.until('document.getElementById("comparison-label").textContent.includes("currently live")');
    return await page.eval('document.getElementById("comparison-note").textContent.includes("No source changes")');
  });
  await page.clickText("#draft-list button", "Authoring tools");
  await page.until('document.getElementById("body").value === "Latest publication"');
  await page.type("#body", "[missing](/not-published/)");
  await check("editing invalidates a previously displayed comparison", async () => await page.eval('document.getElementById("comparison").hidden'));
  await page.click("#preview-toggle");
  await check("preview displays missing-route warnings without blocking readiness", async () => {
    await page.until('document.getElementById("diagnostics").textContent.includes("not published")');
    return await page.until('document.getElementById("publish-readiness").textContent.startsWith("Ready")');
  });
  await page.type("#body", "[home](/)");
  await check("a valid link clears the warning", async () => {
    await page.until('document.getElementById("preview-state").textContent === "up to date"');
    return await page.eval('document.getElementById("diagnostics").hidden');
  });
  const downloads = path.join(harness.work, "downloads");
  await page.type('input[aria-label="Caption for image.png"]', '<script>caption stays text</script>');
  await page.type('input[aria-label="Credit for image.png"]', 'Author credit');
  await page.type('textarea[aria-label="Long description for image.png"]', 'The measured trend rises over time.');
  await page.click('#attachment-list button[aria-label="Insert image.png"]');
  await check("image details insert into source and render semantically in the sandbox", async () => {
    await page.until('document.getElementById("body").value.includes("::image[") && document.getElementById("preview-state").textContent === "up to date"');
    // Chromium isolates the opaque-origin preview in a separate target.
    const { targetInfos } = await page.send("Target.getTargets");
    const target = targetInfos.find((t) => t.type === "iframe" && t.browserContextId === page.browserContextId);
    assert.ok(target, "the sandboxed preview has loaded");
    const { sessionId } = await page.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    let rendered = false;
    for (let i = 0; i < 75 && !rendered; i++) {
      const { result } = await page.send("Runtime.evaluate", { returnByValue: true,
        expression: 'Boolean(document.querySelector("figure.article-image figcaption")) && document.querySelector(".image-caption").textContent === "<script>caption stays text</script>" && document.querySelector(".image-credit").textContent.includes("Author credit") && document.querySelector(".image-description").textContent.includes("rises over time") && document.querySelectorAll(".article-image script").length === 0',
      }, sessionId);
      rendered = result.value === true;
      if (!rendered) await sleep(200);
    }
    await page.send("Target.detachFromTarget", { sessionId });
    return rendered;
  });
  fs.mkdirSync(downloads);
  await page.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, browserContextId: page.browserContextId });
  await page.click("#export-package");
  await check("the complete export button downloads a ZIP containing verified assets", async () => {
    await page.until('document.getElementById("export-note").textContent.startsWith("Exported saved")');
    const names = fs.readdirSync(downloads).filter((name) => name.endsWith(".zip"));
    assert.equal(names.length, 1);
    const bytes = fs.readFileSync(path.join(downloads, names[0]));
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.ok(bytes.includes(Buffer.from("images/image.png")));
    fs.writeFileSync("/tmp/weblog-export-browser.zip", bytes);
    return true;
  });
  await check("authoring tools do not overflow a phone", async () => {
    await page.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    return await page.eval('document.documentElement.scrollWidth <= innerWidth + 1');
  });
  await page.click("#history-refresh");
  await page.until('document.getElementById("checkpoint-select").options.length === 1');
  await page.click("#checkpoint-compare");
  await check("checkpoint comparison identifies its named baseline", async () => {
    await page.until('document.getElementById("comparison-label").textContent.includes("Before restructuring")');
    return true;
  });
  await page.click("#checkpoint-restore");
  await check("checkpoint restore makes a new save without removing attachments", async () => {
    await page.until('document.getElementById("body").value === "Original text"');
    return (await drafts.get(first.draft.postId)).draft.body === "Original text" && (await uploads.list(first.draft.postId)).length === 1;
  });
  await check("no script or server errors", async () => scriptErrors.length === 0 && serverErrors.length === 0);
} finally { await harness.shutdown(); }
harness.finish();
