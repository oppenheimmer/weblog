// Real IndexedDB, navigation, HTTP faults and shared-context tabs in Chromium.
import { startEditorHarness, PASSWORD, sleep } from "./editor-harness.mjs";
import { createDraftStore } from "../lib/server/drafts.mjs";

let mode = "ok", calls = 0, closed = false;
const harness = await startEditorHarness({ requestHook(req, res, url) {
  if (!url.pathname.startsWith("/api/drafts/") || !["POST", "PUT"].includes(req.method) || url.search) return false;
  calls++;
  if (mode === "fail") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Deliberate local outage." })); return true;
  }
  if (mode === "stall") {
    res.writeHead(200, { "content-type": "application/json" }); res.write('{"draft":');
    res.on("close", () => { closed = true; }); return true;
  }
  if (mode === "lost" || mode === "delay") {
    const action = mode; mode = "ok";
    const end = res.end.bind(res);
    res.end = (...args) => action === "lost" ? end('{"draft":') : setTimeout(() => end(...args), 2400);
  }
  return false;
} });
const { check, store } = harness;
const drafts = createDraftStore(store);
const value = (id) => `document.getElementById(${JSON.stringify(id)})`;
const copies = async (page) => page.eval(`import('/assets/recovery.mjs').then(m => m.createRecoveryStore().list()).then(x => x.copies)`);
async function login(page) {
  await page.goto(`${harness.SITE}/login/`);
  await page.type("#password", PASSWORD); await page.click("#login-submit");
  await page.until(`location.pathname === '/editor/' && ${value("save-state")}?.textContent === 'not saved'`);
}
async function open(page, title) {
  await page.until(`[...document.querySelectorAll('#draft-list button')].some(b => b.textContent.includes(${JSON.stringify(title)}))`);
  await page.clickText("#draft-list button", title);
  await page.until(`${value("title")}.value === ${JSON.stringify(title)}`);
}
async function local(page) { await page.until(`${value("recovery-status")}.textContent.startsWith('Saved on this device')`); }
async function saved(page) { await page.until(`/^(auto)?saved/.test(${value("save-state")}.textContent)`); }
async function blank(page) {
  await page.click("#new-post");
  await page.until(`${value("title")}.value === '' && ${value("save-state")}.textContent === 'not saved'`);
}
async function choose(page, title) {
  await page.until(`[...${value("recovery-copy")}.options].some(o => o.textContent.includes(${JSON.stringify(title)}))`);
  await page.eval(`${value("recovery-panel")}.open = true; ${value("recovery-copy")}.value = [...${value("recovery-copy")}.options].find(o => o.textContent.includes(${JSON.stringify(title)})).value`);
}

try {
  const original = await drafts.create({ title: "Recovery probe", date: "2026-10-29", description: "before", tags: ["original"], body: "server text" });
  const page = await harness.openPage();
  await login(page); await open(page, "Recovery probe");
  mode = "fail";
  await page.type("#body", "unsaved source ✓"); await page.type("#description", "unsaved metadata"); await page.type("#tags", "recovery, unicode");
  await page.click("#save"); await local(page);
  await page.until(`${value("editor-error")}.textContent.includes('Deliberate local outage')`);
  await check("device success is separate from a failed server save", async () =>
    (await drafts.get(original.draft.postId)).draft.body === "server text" && (await copies(page))[0].fields.body === "unsaved source ✓");
  await page.reload(); await choose(page, "Recovery probe");
  await page.click("#recovery-compare");
  await check("reload offers safe source/metadata comparison without changing the server", async () => {
    await page.until(`!${value("comparison")}.hidden`);
    return await page.eval(`${value("comparison")}.textContent.includes('unsaved source ✓') && ${value("comparison")}.textContent.includes('unsaved metadata')`) && (await drafts.get(original.draft.postId)).draft.body === "server text";
  });
  await page.click("#comparison-close"); mode = "ok";
  await page.click("#recovery-recover"); await saved(page);
  await check("Recover restores all authored fields and removes only its acknowledged copy", async () =>
    (await drafts.get(original.draft.postId)).draft.description === "unsaved metadata" &&
    JSON.stringify((await drafts.get(original.draft.postId)).draft.tags) === '["recovery","unicode"]' && (await copies(page)).length === 0);

  await blank(page); mode = "fail";
  await page.type("#title", "Never saved"); await page.type("#body", "new draft survives");
  await local(page); await page.reload(); await choose(page, "Never saved");
  mode = "ok"; await page.click("#recovery-recover"); await saved(page);
  await check("a never-saved new draft survives reload and becomes one server draft", async () =>
    (await drafts.list()).filter((d) => d.title === "Never saved").length === 1 && (await copies(page)).length === 0);

  await blank(page); await page.type("#title", "x".repeat(301)); await page.type("#body", "fix validation"); await page.click("#save");
  await page.until(`${value("editor-error")}.textContent.includes('300')`);
  await page.type("#title", "Corrected new draft"); await saved(page);
  await check("correcting rejected new-draft fields replaces the refused request body", async () =>
    (await drafts.list()).filter((d) => d.title === "Corrected new draft").length === 1);

  await blank(page); mode = "lost";
  await page.type("#title", "Lost response"); await page.type("#body", "committed before disconnect");
  await page.click("#save");
  await page.until(`${value("editor-error")}.textContent.includes('response was interrupted')`);
  await page.reload(); await choose(page, "Lost response");
  await page.click("#recovery-recover"); await saved(page);
  await check("a committed POST with a truncated response replays once after reload", async () =>
    (await drafts.list()).filter((d) => d.title === "Lost response").length === 1 && (await copies(page)).length === 0);

  // Acknowledgement must not delete text typed while the request was in flight.
  mode = "delay";
  await page.type("#body", "request snapshot"); await page.click("#save");
  await sleep(150); mode = "fail"; await page.type("#body", "typed during slow save");
  await local(page); await sleep(2600);
  await check("a delayed server ACK preserves a newer device snapshot", async () =>
    (await copies(page)).some((c) => c.fields.body === "typed during slow save") && await page.eval(`${value("body")}.value === 'typed during slow save'`));
  mode = "ok"; await page.click("#save"); await saved(page);

  // Expire the actual session; exercise the real login handler and rotated CSRF.
  await page.eval(`fetch('/api/auth/session/').then(r=>r.json()).then(s=>fetch('/api/auth/logout/', {method:'POST', headers:{'x-csrf-token':s.csrfToken}}))`);
  await page.type("#body", "text through expired session"); await page.click("#save");
  await page.until(`!${value("reauth-form")}.hidden`); await local(page);
  const expiredCalls = calls;
  await page.type("#body", "still typing after expiry"); await sleep(1600);
  await check("session expiry stops save retries while edits remain recoverable", async () => calls === expiredCalls && (await copies(page))[0].fields.body === "still typing after expiry");
  await page.type("#reauth-password", "wrong password"); await page.click("#reauth-submit");
  await page.until(`${value("reauth-error")}.textContent.length > 0`);
  await check("failed reauthentication preserves text and clears the password", () => page.eval(`${value("body")}.value === 'still typing after expiry' && ${value("reauth-password")}.value === ''`));
  await page.type("#reauth-password", PASSWORD); await page.click("#reauth-submit"); await saved(page);
  await check("in-place sign-in resumes saving using the new CSRF token", async () => (await copies(page)).length === 0 && await page.eval(`${value("reauth-form")}.hidden`));

  // Two actual tabs share IndexedDB and cookies but keep separate recovery ids.
  await open(page, "Recovery probe"); mode = "fail";
  await page.type("#body", "first tab unsaved"); await local(page);
  const other = await harness.openPage({ context: page.browserContextId });
  await other.goto(`${harness.SITE}/editor/`); await open(other, "Recovery probe");
  await other.type("#body", "second tab unsaved"); await local(other);
  await check("two tabs editing one post keep independent recovery copies", async () => {
    const bodies = (await copies(page)).map((c) => c.fields.body);
    return bodies.includes("first tab unsaved") && bodies.includes("second tab unsaved");
  });
  mode = "ok"; await other.click("#save"); await saved(other);
  await page.reload(); await choose(page, "Recovery probe"); await page.click("#recovery-recover");
  await check("recovering against a changed server draft requires an explicit conflict choice", async () => {
    await page.until(`!${value("conflict")}.hidden`);
    return (await drafts.get(original.draft.postId)).draft.body === "second tab unsaved" && await page.eval(`${value("body")}.value === 'first tab unsaved'`);
  });
  await page.click("#conflict-theirs");
  await check("loading the server version clears the rejected local copy", async () => {
    await page.until(`${value("body")}.value === 'second tab unsaved'`);
    await sleep(150); return (await copies(page)).length === 0;
  });

  await other.eval(`fetch('/api/auth/login/', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:${JSON.stringify(PASSWORD)}})})`);
  await page.type("#body", "after another tab signed in"); await page.click("#save"); await saved(page);
  await check("another tab rotating the session does not strand this tab's CSRF token", async () =>
    (await drafts.get(original.draft.postId)).draft.body === "after another tab signed in");

  // Exercise the actual 15-second body deadline, with no fake clock or fetch.
  mode = "stall"; calls = 0; closed = false;
  await page.type("#body", "deadline recovery"); await page.click("#save");
  await check("a stalled successful response body times out and aborts its socket", async () => {
    await page.until(`${value("editor-error")}.textContent.toLowerCase().includes('timed out')`, 20_000);
    await sleep(100); return closed && calls === 1 && (await copies(page)).some((c) => c.fields.body === "deadline recovery");
  });
  mode = "fail"; calls = 0; await page.click("#save");
  await check("persistent outages stop after three retries, including during further typing", async () => {
    await page.until(`${value("editor-error")}.textContent.includes('Automatic saving paused')`, 20_000);
    const count = calls; await page.type("#body", "after retry budget"); await sleep(1800);
    return count === 4 && calls === count;
  });
  mode = "ok"; await page.click("#save"); await saved(page);
  await check("manual Save resumes after the retry budget is exhausted", async () => (await drafts.get(original.draft.postId)).draft.body === "after retry budget");

  const removed = await drafts.create({ title: "Deleted remotely", body: "old" });
  await page.reload(); await open(page, "Deleted remotely");
  mode = "fail"; await page.type("#body", "rescue after deletion"); await local(page);
  await drafts.remove(removed.draft.postId);
  await page.reload(); await choose(page, "Deleted remotely");
  await page.click("#recovery-recover");
  await page.until(`${value("editor-error")}.textContent.includes('No such draft')`);
  await check("a missing server draft keeps its copy until explicit recovery as new", async () => (await copies(page)).some((c) => c.fields.body === "rescue after deletion"));
  mode = "ok"; await page.click("#recovery-new"); await saved(page);
  await check("explicit recovery as new creates a separate post after remote deletion", async () => {
    const replacement = (await drafts.list()).find((d) => d.title === "Deleted remotely");
    return replacement?.postId !== removed.draft.postId && (await drafts.get(replacement.postId)).draft.body === "rescue after deletion";
  });
  await open(page, "Recovery probe");

  // Actual network-offline event and reconnection, without replacing fetch.
  await page.call("Network.enable");
  await page.call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.type("#body", "network returned"); await page.click("#save"); await local(page);
  await page.call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await saved(page);
  await check("reconnection resumes the ordinary conditional save", async () => (await drafts.get(original.draft.postId)).draft.body === "network returned");

  // Disabled-recovery control proves the reload test detects the original loss.
  await page.eval(`${value("recovery-panel")}.open = true`); await page.click("#recovery-enabled");
  mode = "fail"; await page.type("#body", "control text intentionally not retained"); await sleep(350);
  await page.reload(); await open(page, "Recovery probe");
  await check("control: disabling recovery recreates loss on reload and stays disabled", async () =>
    (await copies(page)).length === 0 && await page.eval(`!${value("recovery-enabled")}.checked && ${value("body")}.value === 'network returned'`));
  await page.eval(`${value("recovery-panel")}.open = true`); await page.click("#recovery-enabled");

  // Fill/prune real IndexedDB through its public store API; no mocked database.
  await check("the device limit refuses an eleventh copy without evicting unsaved work", async () => page.eval(`(async()=>{
    const {createRecoveryStore}=await import('/assets/recovery.mjs'); const s=createRecoveryStore();
    for(let i=0;i<10;i++) await s.put({id:'limit-'+i,fields:{title:'Limit '+i,body:'keep '+i}});
    let refused=false; try{await s.put({id:'eleventh',fields:{body:'overflow'}})}catch(e){refused=e.message.includes('full')}
    return refused && (await s.list()).copies.length===10;
  })()`));
  await check("the byte limit preserves existing copies on refusal", async () => page.eval(`(async()=>{
    const s=(await import('/assets/recovery.mjs')).createRecoveryStore(); await s.clear();
    await s.put({id:'keep',fields:{body:'small'}});
    let refused=false; try{await s.put({id:'large',fields:{body:'x'.repeat(11*1024*1024)}})}catch(e){refused=e.message.includes('full')}
    return refused && (await s.list()).copies.length===1;
  })()`));
  await check("expired copies are pruned using real IndexedDB records", async () => page.eval(`(async()=>{
    const s=(await import('/assets/recovery.mjs')).createRecoveryStore(); await s.clear();
    await s.put({id:'expired',fields:{body:'old'}});
    await new Promise((resolve,reject)=>{const r=indexedDB.open('weblog-editor-recovery',1);r.onsuccess=()=>{const d=r.result,t=d.transaction('copies','readwrite'),o=t.objectStore('copies'),g=o.get('expired');g.onsuccess=()=>o.put({...g.result,updatedAt:Date.now()-8*86400000});t.oncomplete=()=>{d.close();resolve()};t.onerror=reject}});
    return (await s.list()).copies.length===0;
  })()`));
  await check("a blocked device transaction times out without committing a partial copy", async () => page.eval(`(async()=>{
    const s=(await import('/assets/recovery.mjs')).createRecoveryStore(); await s.clear();
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('weblog-editor-recovery',1);r.onsuccess=()=>resolve(r.result);r.onerror=reject});
    const tx=db.transaction('copies','readwrite'), records=tx.objectStore('copies'); let hold=true;
    const keepBusy=()=>{if(!hold)return; const r=records.get('hold'); r.onsuccess=keepBusy}; keepBusy();
    const start=Date.now(); let refused=false;
    try{await s.put({id:'blocked',fields:{body:'never committed'}})}catch{refused=true}
    finally{hold=false; try{tx.abort()}catch{} db.close()}
    const elapsed=Date.now()-start;
    return refused && elapsed>=3800 && elapsed<6500 && (await s.list()).copies.length===0;
  })()`));
  await page.type("#body", "clear this copy"); await local(page);
  await page.click("#recovery-clear");
  await check("explicit clear removes device copies while preserving on-screen text", async () => (await copies(page)).length === 0 && await page.eval(`${value("body")}.value === 'clear this copy'`));

  await page.type("#body", "logout text"); await local(page); await page.click("#logout");
  await check("explicit logout clears and locks recovery across the other open tab", async () => {
    await page.until("location.pathname === '/login/'");
    await other.until(`!${value("reauth-form")}.hidden`);
    await other.type("#body", "must not recreate after logout"); await sleep(500);
    return (await copies(other)).length === 0;
  });
  await other.close(); await page.close(); mode = "ok";

  const unavailable = await harness.openPage({ width: 390, height: 844 });
  await unavailable.call("Page.addScriptToEvaluateOnNewDocument", { source: `IDBFactory.prototype.open = function(){throw new DOMException('Storage blocked by browser settings','SecurityError')}` });
  await login(unavailable); await unavailable.type("#title", "Without device storage"); await unavailable.type("#body", "server still works");
  await unavailable.click("#save"); await saved(unavailable);
  await check("blocked device storage is visible and does not block server saving", async () =>
    (await drafts.list()).some((d) => d.title === "Without device storage") && await unavailable.eval(`${value("recovery-status")}.textContent.includes('Device recovery unavailable')`));
  await check("recovery controls fit a phone viewport", () => unavailable.eval("document.documentElement.scrollWidth <= innerWidth"));
  await unavailable.close();
  await check("recovery flows have no unhandled browser or server exceptions", () => harness.scriptErrors.length === 0 && harness.serverErrors.length === 0 || JSON.stringify({ browser: harness.scriptErrors, server: harness.serverErrors }));
} catch (err) {
  await check("recovery scenarios completed", () => err.stack);
} finally { await harness.shutdown(); }
harness.finish();
