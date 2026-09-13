// Proves, in a real browser, the editor's interactive controls and Run
// preview (CLAUDE.md §3.6).
//
//   node scripts/verify-editor-interactives.mjs
//   node scripts/verify-editor-interactives.mjs --control
//
// Folders are chosen through the browser's own file chooser: the editor's
// button opens it, and DevTools answers it with a directory from disk, which
// Chromium expands with relative paths exactly as a person's pick would be.
// Every file then goes sign -> PUT -> verify through the real handlers.
//
// What a running preview can do is read from the server's side. Each bundle
// reports by image beacon, and the stand-in records every request with its
// origin and whether it carried a cookie, so "the figure could not reach the
// editor" is a request that never carried the session, not a promise that
// rejected.
//
// `--control` serves an editor that gives the Run frame its own origin back.
// The checks that the editor stays out of reach must then fail, and the run
// passes only if they do.
import fs from "node:fs";
import path from "node:path";

import { startEditorHarness, ROOT, PASSWORD, sleep } from "./editor-harness.mjs";

const CONTROL = process.argv.includes("--control");
const GRANT_LINE = 'running ? "allow-scripts" : ""';
const BROKEN_LINE = 'running ? "allow-scripts allow-same-origin" : ""';

const harness = await startEditorHarness({
  editorScript: CONTROL ? (text) => text.replace(GRANT_LINE, BROKEN_LINE) : undefined,
});
const { SITE, openPage, check, results, scriptErrors, serverErrors, requests, logLines, work } = harness;

if (CONTROL && !fs.readFileSync(path.join(ROOT, "assets", "editor.js"), "utf8").includes(GRANT_LINE)) {
  console.log("The control cannot break an editor that no longer contains the line it replaces.");
  await harness.shutdown();
  process.exit(2);
}

// ---- two folders, written as an author would lay them out ----------------------

function writeFolder(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

const BEACON = 'const hit = (p) => { new Image().src = "/hit/" + p; };\n';
const LAB_DIR = writeFolder(path.join(work, "folders", "lab"), {
  "index.html": '<!doctype html><meta charset="utf-8"><title>lab</title>\n<p>A running lab.</p>\n' +
    '<script type="module" src="./demo.mjs"></script>\n',
  "demo.mjs": `import { label } from "./lib/nested.mjs";\n${BEACON}` +
    'hit("lab-module/" + label);\n' +
    'hit("lab-origin/" + encodeURIComponent(String(self.origin)));\n' +
    'try { top.document.title; hit("lab-editor/reached"); } catch { hit("lab-editor/denied"); }\n' +
    'fetch("./data.json").then((r) => r.json()).then((d) => hit("lab-data/" + d.version), () => hit("lab-data/blocked"));\n' +
    'fetch("/api/drafts/", { credentials: "include" }).then((r) => r.text()).then(() => hit("lab-drafts/read"), () => hit("lab-drafts/refused"));\n',
  "lib/nested.mjs": 'export const label = "nested";\n',
  "data.json": '{"version": 1}\n',
  "fallback.html": '<p>The lab, standing still.</p><img src="still.png" alt="a still of the lab" />\n',
  "still.png": fs.readFileSync(path.join(ROOT, "test/fixtures/media/sample-7x11.png")),
  // What a file manager leaves behind. The editor leaves it out.
  ".DS_Store": "",
});
const CHART_DIR = writeFolder(path.join(work, "folders", "chart"), {
  "main.mjs": `${BEACON}export function mount(root) {\n` +
    '  root.textContent = "chart mounted";\n' +
    '  hit("figure-mounted/" + encodeURIComponent(typeof d3 === "object" ? d3.version : "no-d3"));\n' +
    '  hit("figure-article/" + encodeURIComponent(document.querySelector(".post-title")?.textContent ?? "none"));\n' +
    '  try { top.document.title; hit("figure-editor/reached"); } catch { hit("figure-editor/denied"); }\n' +
    '  try { localStorage.getItem("x"); hit("figure-storage/readable"); } catch { hit("figure-storage/denied"); }\n' +
    '  fetch("/api/drafts/", { credentials: "include" }).then((r) => r.text()).then(() => hit("figure-drafts/read"), () => hit("figure-drafts/refused"));\n' +
    "}\n",
  "interactive.json": '{"dependencies": ["d3"]}\n',
  "fallback.html": "<p>The chart, standing still.</p>\n",
});

// ---- helpers ------------------------------------------------------------------

const hits = () => requests.filter((r) => r.path.startsWith("/hit/")).map((r) => decodeURIComponent(r.path.slice(5)));
const hitCount = (name) => hits().filter((hit) => hit === name).length;
async function untilHits(names, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (names.every((name) => hits().includes(name))) return true;
    await sleep(100);
  }
  return { missing: names.filter((name) => !hits().includes(name)), seen: hits() };
}

const ROWS = `[...document.querySelectorAll("#interactive-list .attachment")].map((li) => ({
  name: li.querySelector(".attachment-name").textContent,
  meta: li.querySelector(".attachment-meta").textContent,
}))`;
const FRAME = `({
  sandbox: document.getElementById("preview-frame").getAttribute("sandbox"),
  state: document.getElementById("preview-state").textContent,
  pressed: document.getElementById("preview-run").getAttribute("aria-pressed"),
})`;
const statusIs = (text) => `document.getElementById("interactive-status").textContent.includes(${JSON.stringify(text)})`;

let page;
async function chooseFolder(click, dir) {
  const opened = page.waitFor("Page.fileChooserOpened");
  await click();
  const { backendNodeId } = await opened;
  await page.call("DOM.setFileInputFiles", { backendNodeId, files: [dir] });
}

try {
  page = await openPage();
  await page.call("Page.setInterceptFileChooserDialog", { enabled: true });

  console.log("\nSigning in:");
  await page.goto(`${SITE}/login/`);
  await page.type("#password", PASSWORD);
  await page.click("#login-submit");
  await check("the password opens the editor", async () =>
    (await page.until(`location.pathname === "/editor/" && document.getElementById("save-state").textContent === "not saved"`)) === true);

  console.log("\nAttaching folders:");
  await page.type("#title", "Orbits");
  await page.type("#slug", "orbits");
  // Written the way a staged post names its folder.
  await page.type("#body", "An introduction.\n\n::demo[lab]\n\nA closing line.");
  await page.until(`/^autosaved · v1$/.test(document.getElementById("save-state").textContent)`);

  await chooseFolder(() => page.click("#attach-lab"), LAB_DIR);
  await check("a lab folder attaches file by file, leaving out what the file manager left", async () => {
    await page.until(statusIs("Attached lab"));
    const seen = await page.eval(`({ rows: ${ROWS}, status: document.getElementById("interactive-status").textContent })`);
    const puts = requests.filter((r) => r.method === "PUT" && r.path.startsWith("/local-upload/")).length;
    return (seen.rows.length === 1 && seen.rows[0].name === "lab" && /^Lab · 6 files · /.test(seen.rows[0].meta) &&
      /Left out 1 hidden file\./.test(seen.status) && puts === 6) || { ...seen, puts };
  });
  await check("the folder's name in the body becomes the interactive's id, as the staging push writes it", async () => {
    const body = await page.eval(`document.getElementById("body").value`);
    return (/::demo\[i_[0-9a-f]{16}\]/.test(body) && !body.includes("::demo[lab]")) || body;
  });

  await chooseFolder(() => page.click("#attach-figure"), CHART_DIR);
  await check("a figure folder attaches with the library its interactive.json declares, inserted on its own line", async () => {
    await page.until(statusIs("Attached chart and inserted it."));
    const seen = await page.eval(`({ rows: ${ROWS}, body: document.getElementById("body").value })`);
    const chart = seen.rows.find((row) => row.name === "chart");
    return (chart && /^Figure · 2 files · .* · uses d3 · iv_[0-9a-f]{16}$/.test(chart.meta) &&
      /\n::figure\[i_[0-9a-f]{16}\]\n/.test(seen.body)) || seen;
  });
  await check("beside Publish, the post is said to go out with one figure and one lab", async () =>
    (await page.until(`document.getElementById("publish-readiness").textContent.includes("with 1 figure and 1 lab")`)) === true);

  console.log("\nPreview, then Run:");
  await page.click("#preview-toggle");
  await check("an ordinary preview runs nothing, and shows the lab's fallback image from its unpublished bundle", async () => {
    const frame = await page.until(`document.getElementById("preview-state").textContent === "up to date" && ${FRAME}`);
    const still = await (async () => {
      for (let i = 0; i < 50; i++) {
        const found = requests.some((r) => r.path.startsWith("/local-download/") &&
          Buffer.from(r.path.slice("/local-download/".length), "base64url").toString("utf8").endsWith("/files/still.png"));
        if (found) return true;
        await sleep(100);
      }
      return false;
    })();
    const ran = hits().length || requests.some((r) => r.path.startsWith("/api/preview/run/"));
    const runShown = await page.eval(`!document.getElementById("preview-run").hidden`);
    return (frame.sandbox === "" && still && !ran && runShown) || { frame, still, ran, runShown };
  });

  await page.click("#preview-run");
  await check("Run gives the frame scripts and runs both interactives", async () => {
    const frame = await page.until(`document.getElementById("preview-state").textContent === "running 2 interactives" && ${FRAME}`);
    return (frame.sandbox === "allow-scripts" && frame.pressed === "true") || frame;
  });
  await check("the lab runs sealed from its grant: its module, a nested module and its own data all load", async () =>
    untilHits(["lab-module/nested", "lab-data/1", "lab-origin/null"]));
  await check("the figure mounts as page code of the previewed article, with d3 loaded from this site", async () =>
    untilHits(["figure-mounted/7.9.0", "figure-article/Orbits"]));
  await check("neither can reach the editor's document or storage, nor read a draft", async () => {
    const settled = await untilHits(["lab-editor/denied", "figure-editor/denied", "figure-storage/denied",
      "lab-drafts/refused", "figure-drafts/refused"]);
    const reached = hits().filter((hit) => /reached|readable|drafts\/read/.test(hit));
    return (settled === true && reached.length === 0) || { settled, reached };
  });
  await check("no request from a running interactive carried the session cookie", async () => {
    const fromFrames = requests.filter((r) => r.path.startsWith("/api/preview/run/") ||
      (r.path.startsWith("/api/") && r.origin === "null"));
    const carried = fromFrames.filter((r) => r.cookie);
    const draftsTried = fromFrames.filter((r) => r.path === "/api/drafts/").length;
    return (fromFrames.length > 0 && draftsTried === 2 && carried.length === 0) || { carried, draftsTried };
  });
  await check("a lab's run address, opened directly, is sandboxed by its own response", async () => {
    const entry = requests.find((r) => /^\/api\/preview\/run\/[^/]+\/$/.test(r.path));
    if (!entry) return "no lab entry was requested";
    const res = await fetch(`${SITE}${entry.path}`);
    await res.arrayBuffer();
    return (res.status === 200 && res.headers.get("content-security-policy") === "sandbox allow-scripts" &&
      res.headers.get("access-control-allow-origin") === "*") ||
      { status: res.status, csp: res.headers.get("content-security-policy") };
  });
  await check("no grant reached the request log", () => {
    const grants = new Set(requests.map((r) => /^\/api\/preview\/run\/([^/]+)\//.exec(r.path)?.[1]).filter(Boolean));
    const logged = [...grants].filter((grant) => logLines.some((line) => line.includes(grant)));
    return (grants.size > 0 && logged.length === 0) || { grants: grants.size, logged };
  });

  await check("typing while running leaves the interactives running, and says edits wait for Stop", async () => {
    const before = hitCount("lab-module/nested");
    await page.eval(`(() => {
      const body = document.getElementById("body");
      body.value += " More.";
      body.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(1500);
    const frame = await page.eval(FRAME);
    return (hitCount("lab-module/nested") === before && frame.state === "running · Stop to see edits" &&
      frame.sandbox === "allow-scripts") || { before, after: hitCount("lab-module/nested"), frame };
  });
  await page.click("#preview-run");
  await check("Stop takes scripts away again and shows the edits", async () => {
    const frame = await page.until(`document.getElementById("preview-state").textContent === "up to date" && ${FRAME}`);
    return (frame.sandbox === "" && frame.pressed === "false") || frame;
  });

  console.log("\nPublish, replace, put back:");
  const currentLab = async () => (await page.eval(ROWS)).find((row) => row.name === "lab").meta.split(" · ").at(-1);
  const publishedLab = async () => {
    const { data } = await harness.publisher.readIndex();
    const entry = data.posts?.orbits;
    if (!entry) return null;
    const revision = (await harness.store.getJson(`published/posts/${entry.postId}/${entry.revisionId}.json`))?.data;
    return { revisionId: entry.revisionId, lab: revision?.interactives?.find((item) => item.kind === "demo")?.revisionId };
  };
  const publishNow = async () => {
    await page.click("#publish");
    await page.until(`document.getElementById("editor-published").textContent.startsWith("Published")`);
    await page.eval(`document.getElementById("editor-published").textContent = ""`);
  };

  const v1 = await currentLab();
  await publishNow();
  await check("the post publishes with its lab", async () => ((await publishedLab())?.lab === v1) || await publishedLab());
  const firstPublished = await publishedLab();
  const LISTS = `({
    drafts: [...document.querySelectorAll("#draft-list button")].map((b) => b.textContent),
    site: [...document.querySelectorAll("#publication-list .draft-title")].map((t) => t.textContent),
  })`;
  await check("once published, the post leaves Drafts and is listed under On the site", async () => {
    const lists = await page.until(`${LISTS}.site.includes("Orbits") && !${LISTS}.drafts.some((text) => text.includes("Orbits")) && ${LISTS}`);
    return lists === true || Boolean(lists.site) || lists;
  });

  fs.writeFileSync(path.join(LAB_DIR, "data.json"), '{"version": 2}\n');
  await chooseFolder(() => page.click('#interactive-list button[aria-label="Replace lab with a folder"]'), LAB_DIR);
  await check("Replace uploads a new revision under the same name", async () => {
    await page.until(statusIs("Replaced lab with a new revision."));
    const rows = await page.eval(ROWS);
    return (rows.length === 2 && rows.filter((row) => row.name === "lab").length === 1 && await currentLab() !== v1) || rows;
  });
  const v2 = await currentLab();
  await page.click("#preview-run");
  await check("running again runs the new revision", async () => untilHits(["lab-data/2"]));
  await page.click("#preview-run");
  await page.until(`document.getElementById("preview-state").textContent === "up to date"`);

  await publishNow();
  await check("Publish with unchanged words puts the new bundle revision on the site, as a draft revision of its own", async () => {
    const now = await publishedLab();
    return (now?.lab === v2 && now.revisionId !== firstPublished.revisionId) || { now, firstPublished };
  });
  await check("and this tab saves against that revision afterwards, with no conflict", async () => {
    await page.eval(`(() => {
      const body = document.getElementById("body");
      body.value += " Saved after.";
      body.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const status = await page.until(`/^autosaved · v\\d+$|conflict/.test(document.getElementById("save-state").textContent) &&
      ({ status: document.getElementById("save-state").textContent, dialog: !document.getElementById("conflict").hidden })`);
    return (/^autosaved/.test(status.status) && !status.dialog) || status;
  });
  await check("a saved change the site does not show lists it under Drafts again, marked", async () => {
    const entry = await page.until(`${LISTS}.drafts.find((text) => text.includes("Orbits"))`);
    return /changes not on the site$/.test(entry) || entry;
  });

  fs.writeFileSync(path.join(LAB_DIR, "data.json"), '{"version": 1}\n');
  await chooseFolder(() => page.click('#interactive-list button[aria-label="Replace lab with a folder"]'), LAB_DIR);
  await check("replacing with the earlier folder puts that revision back, transferring nothing", async () => {
    await page.until(statusIs("Put lab back to its earlier revision"));
    return (await currentLab() === v1) || await currentLab();
  });
  const CHOOSER = `[...document.querySelectorAll('#interactive-list select[aria-label="Revision of lab"] option')]
    .map((option) => option.textContent)`;
  await check("the lab offers its revisions, the one in use first", async () => {
    const options = await page.until(`${CHOOSER}.length === 2 && ${CHOOSER}`);
    return (options[0].startsWith(v1) && options[0].endsWith("(in use)") && options[1].startsWith(v2)) || options;
  });
  await page.eval(`(() => {
    const select = document.querySelector('#interactive-list select[aria-label="Revision of lab"]');
    select.value = ${JSON.stringify(v2)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.click('#interactive-list button[aria-label="Use the chosen revision of lab"]');
  await check("choosing an earlier revision and Use makes it the one the post publishes", async () => {
    await page.until(statusIs(`lab now uses revision ${v2}`));
    return (await currentLab() === v2) || await currentLab();
  });

  for (const version of [3, 4]) {
    fs.writeFileSync(path.join(LAB_DIR, "data.json"), `{"version": ${version}}\n`);
    // Each Replace reports the same words, so a wait on them would match the
    // previous one's report. Found on a CI runner, which read the list early.
    await page.eval(`document.getElementById("interactive-status").textContent = ""`);
    await chooseFolder(() => page.click('#interactive-list button[aria-label="Replace lab with a folder"]'), LAB_DIR);
    await page.until(statusIs("Replaced lab with a new revision."));
  }
  await check("four revisions later, three are offered", async () => {
    const options = await page.until(`${CHOOSER}.length >= 3 && ${CHOOSER}`);
    return (options.length === 3 && options[0].endsWith("(in use)") && !options.some((option) => option.startsWith(v1)) &&
      options[0].startsWith(await currentLab())) || options;
  });

  await chooseFolder(() => page.click("#attach-figure"), CHART_DIR);
  await check("attaching a folder under a name the post already has asks, and an unchanged one uploads nothing", async () => {
    const putsBefore = requests.filter((r) => r.method === "PUT").length;
    await page.until(statusIs("chart is unchanged"));
    const asked = page.dialogs.some((text) => text.includes("already has a figure called chart"));
    const rows = await page.eval(ROWS);
    return (asked && rows.length === 2 && requests.filter((r) => r.method === "PUT").length === putsBefore) ||
      { asked, rows };
  });

  await page.click('#interactive-list button[aria-label="Remove chart"]');
  await check("Remove takes the figure off the draft, and Publish is then said to refuse its reference", async () => {
    await page.until(statusIs("Removed chart."));
    const rows = await page.eval(ROWS);
    const readiness = await page.until(`document.getElementById("publish-readiness").textContent.startsWith("Not ready") &&
      document.getElementById("publish-readiness").textContent`);
    return (rows.length === 1 && /not attached/.test(readiness)) || { rows, readiness };
  });

  console.log("\nA LaTeX post:");
  await page.eval(`(() => {
    const format = document.getElementById("format");
    format.value = "latex";
    format.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  let chooserOpened = false;
  page.waitFor("Page.fileChooserOpened", 1500).then(() => { chooserOpened = true; }, () => {});
  await page.click("#attach-lab");
  await check("cannot attach an interactive, and says why before any folder is chosen", async () => {
    const error = await page.until(`document.getElementById("editor-error").textContent`);
    await sleep(1600);
    return (/LaTeX post cannot include an interactive/.test(error) && !chooserOpened) || { error, chooserOpened };
  });

  console.log("\nDiscarding the post:");
  const postId = await page.eval(`(() => {
    const format = document.getElementById("format");
    format.value = "markdown";
    format.dispatchEvent(new Event("input", { bubbles: true }));
    return [...document.querySelectorAll("#draft-list button")].length;
  })()`) && requests.map((r) => /^\/api\/drafts\/(p_[0-9a-f]{16})\/$/.exec(r.path)?.[1]).filter(Boolean).at(-1);
  // Published above, so it comes off the site first: discard refuses a post
  // that is still on it.
  await page.click("#publication-unpublish");
  await page.until(`document.getElementById("publication-unpublish").hidden`);
  const jobsNaming = async () => {
    const found = [];
    for (const { key } of await harness.store.listAll("publications/")) {
      if ((await harness.store.getJson(key))?.data?.postId === postId) found.push(key);
    }
    return found;
  };
  const named = async () => [
    ...(await harness.store.listAll("")).map(({ key }) => key).filter((key) => key.includes(postId)),
    ...await jobsNaming(),
  ];
  const before = postId ? (await named()).length : 0;
  const jobsBefore = postId ? (await jobsNaming()).length : 0;
  await page.click("#discard");
  await check("the open preview goes blank, rather than keeping a page template", async () => {
    const frame = await page.until(`document.getElementById("title").value === "" &&
      document.getElementById("preview-state").textContent === "nothing to preview yet" && ({
        srcdoc: document.getElementById("preview-frame").getAttribute("srcdoc"),
        sandbox: document.getElementById("preview-frame").getAttribute("sandbox"),
        rows: document.querySelectorAll("#interactive-list .attachment").length,
      })`);
    return (frame.srcdoc === "" && frame.sandbox === "" && frame.rows === 0) || frame;
  });
  await check("nothing in the bucket names the discarded post, its publication jobs included", async () => {
    const left = await named();
    // Asserted present first, so an empty fixture cannot pass for a clean discard.
    return (before > 0 && jobsBefore > 0 && left.length === 0) || { postId, before, jobsBefore, left };
  });

  await check("no script error was thrown", () => scriptErrors.length === 0 || scriptErrors);
  await check("no request failed inside the server", () => serverErrors.length === 0 || serverErrors);
} finally {
  await harness.shutdown();
}

if (CONTROL) {
  // The boundary checks are the three about reaching the editor, the cookie and
  // the frame's grant; with the frame given its own origin, they must fail.
  const failed = results.filter((ok) => !ok).length;
  console.log(failed
    ? `\ncontrol: ${failed} check(s) failed against an editor that gives the Run frame its origin, as they must`
    : "\ncontrol: every check passed against a broken editor, so the checks measure nothing");
  process.exit(failed ? 0 : 1);
}
harness.finish();
