// The editor client (CLAUDE.md Step 5, Step 7).
//
// Deliberately small and dependency-free: a textarea, metadata fields,
// conditional saves, attachments uploaded straight to storage, a preview
// rendered by the server into a sandboxed frame, and what the site actually
// shows of each published post.
const $ = (id) => document.getElementById(id);

const els = {
    saveState: $("save-state"), draftList: $("draft-list"), draftEmpty: $("draft-empty"),
    title: $("title"), date: $("date"), format: $("format"), slug: $("slug"),
    slugPreview: $("slug-preview"), description: $("description"), tags: $("tags"),
    body: $("body"), save: $("save"), newPost: $("new-post"), logout: $("logout"),
    discard: $("discard"), exportBtn: $("export"), error: $("editor-error"),
    publish: $("publish"), publishedNote: $("editor-published"),
    conflict: $("conflict"), conflictKeep: $("conflict-keep"), conflictTheirs: $("conflict-theirs"),
    conflictDetail: $("conflict-detail"), conflictNote: $("conflict-note"),
    attach: $("attach"), attachInput: $("attach-input"),
    attachmentList: $("attachment-list"), attachStatus: $("attach-status"),
    writing: $("writing"), previewToggle: $("preview-toggle"), previewPane: $("preview-pane"),
    previewFrame: $("preview-frame"), previewState: $("preview-state"), diagnostics: $("diagnostics"),
    publicationList: $("publication-list"), publicationEmpty: $("publication-empty"),
    publication: $("publication"), publicationChip: $("publication-chip"),
    publicationSummary: $("publication-summary"), publicationRevision: $("publication-revision"),
    publicationRollback: $("publication-rollback"), publicationRebuild: $("publication-rebuild"),
    publicationUnpublish: $("publication-unpublish"), rebuildNote: $("rebuild-note"),
};

const state = {
    csrf: null,
    postId: null,
    etag: null,
    // What was last persisted, so "unsaved" is a real comparison rather than a
    // flag that drifts out of sync with the fields.
    saved: null,
    version: null,
    conflict: null,
    saving: false,
    attachments: [],
    drafts: [],
    preview: { open: false, seq: 0, controller: null, timer: null, refresher: null, lastKey: null },
    // What the site shows. `selected` is a post picked from "On the site" whose
    // draft is not the one open; otherwise the panel follows the open draft.
    publications: [],
    site: null,
    selected: null,
    watch: { timer: null, startedAt: null, delay: 0, gaveUp: false },
};

const FIELDS = ["title", "date", "format", "slug", "description", "tags", "body"];

// ---------------------------------------------------------------- helpers

/**
 * Wrap an event handler so a failure is shown rather than lost.
 *
 * A rejected promise inside a listener has nowhere to go: the browser reports
 * an unhandled rejection to the console and the user sees nothing happen. That
 * is exactly how a broken Discard looked like a dead button.
 */
const guard = (fn) => async (...args) => {
    try {
        await fn(...args);
    } catch (err) {
        if (err.message === "unauthenticated") return; // already reported
        setStatus("failed", "error");
        setError(err.message || "Something went wrong.");
    }
};

const setStatus = (text, kind = "") => {
    els.saveState.textContent = text;
    els.saveState.dataset.state = kind;
};
const setError = (text) => { els.error.textContent = text; };

function slugify(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Every request carries the CSRF token; reads simply ignore it.
 *
 * A 409 is an error like any other unless the caller says it resolves conflicts
 * itself, and only a draft save does. When every 409 came back as a success, a
 * publish refused for its address reported itself as published.
 */
async function api(path, { method = "GET", body, etag, signal, conflict = false } = {}) {
    const headers = { "content-type": "application/json" };
    if (state.csrf) headers["x-csrf-token"] = state.csrf;
    if (etag) headers["if-match"] = etag;

    const res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
    });

    if (res.status === 401) {
        // The session went away. Do not silently discard what is on screen.
        setStatus("signed out", "error");
        setError("Your session ended. Export your text, then sign in again.");
        throw new Error("unauthenticated");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !(conflict && res.status === 409)) {
        throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { data, status: res.status });
    }
    return { res, data };
}

// ---------------------------------------------------------------- form <-> draft

function readForm() {
    return {
        title: els.title.value,
        date: els.date.value,
        format: els.format.value,
        slug: els.slug.value,
        description: els.description.value,
        tags: els.tags.value.split(",").map((t) => t.trim()).filter(Boolean),
        body: els.body.value,
    };
}

function writeForm(draft) {
    els.title.value = draft.title ?? "";
    els.date.value = draft.date ?? "";
    els.format.value = draft.format ?? "markdown";
    els.slug.value = draft.slug ?? "";
    els.description.value = draft.description ?? "";
    els.tags.value = (draft.tags ?? []).join(", ");
    els.body.value = draft.body ?? "";
    updateSlugPreview();
}

function updateSlugPreview() {
    const slug = els.slug.value ? slugify(els.slug.value) : slugify(els.title.value);
    els.slugPreview.textContent = slug ? `/${slug}/` : "";
}

const isDirty = () =>
    state.saved !== null && JSON.stringify(readForm()) !== JSON.stringify(state.saved);

// ---------------------------------------------------------------- drafts

async function refreshList() {
    const { data } = await api("/api/drafts/");
    const drafts = data.drafts ?? [];
    state.drafts = drafts;
    els.draftList.replaceChildren();
    els.draftEmpty.hidden = drafts.length > 0;

    for (const draft of drafts) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        if (draft.postId === state.postId) button.setAttribute("aria-current", "true");

        const title = document.createElement("span");
        title.className = "draft-title";
        title.textContent = draft.title || "Untitled";

        const meta = document.createElement("span");
        meta.className = "draft-meta";
        meta.textContent = `v${draft.version} · ${new Date(draft.updatedAt).toLocaleString()}`;

        button.append(title, meta);
        button.addEventListener("click", guard(() => openDraft(draft.postId)));
        li.append(button);
        els.draftList.append(li);
    }
    renderPublications();
}

async function openDraft(postId) {
    if (isDirty() && !confirm("This draft has unsaved changes. Discard them?")) return;
    const { data } = await api(`/api/drafts/${postId}/`);
    state.postId = data.draft.postId;
    state.etag = data.etag;
    state.version = data.draft.version;
    state.selected = null;
    writeForm(data.draft);
    state.saved = readForm();
    await loadAttachments();
    setStatus(`saved · v${data.draft.version}`);
    setError("");
    els.publishedNote.textContent = "";
    await refreshList();
}

async function newPost() {
    if (isDirty() && !confirm("This draft has unsaved changes. Discard them?")) return;
    state.postId = null;
    state.etag = null;
    state.version = null;
    state.selected = null;
    writeForm({ date: new Date().toISOString().slice(0, 10) });
    state.saved = readForm();
    await loadAttachments();
    setStatus("not saved");
    setError("");
    els.publishedNote.textContent = "";
    await refreshList();
}

/** Spell out both sides concretely, without ranking them by age. */
function describeConflict(current) {
    const theirVersion = current?.version;
    const when = current?.updatedAt ? new Date(current.updatedAt).toLocaleTimeString() : null;

    els.conflictDetail.textContent = [
        state.version ? `This tab has been editing version ${state.version}.` : "",
        theirVersion
            ? `Another tab or window saved version ${theirVersion}${when ? ` at ${when}` : ""}.`
            : "Another tab or window saved since this one loaded.",
        "Nothing has been overwritten yet.",
    ].filter(Boolean).join(" ");

    const theirs = theirVersion ? `version ${theirVersion}` : "the saved version";
    els.conflictNote.textContent =
        `"Save mine over it" replaces ${theirs} with the text on this screen. ` +
        `"Discard mine, load saved" replaces what is on this screen with ${theirs} — ` +
        `use Export first if you might want it back.`;
}

async function save({ force = false } = {}) {
    if (state.saving) return;
    state.saving = true;
    els.save.disabled = true;
    setStatus("saving…");
    setError("");

    try {
        const fields = readForm();

        if (!state.postId) {
            const { data } = await api("/api/drafts/", { method: "POST", body: fields });
            state.postId = data.draft.postId;
            state.etag = data.etag;
            state.version = data.draft.version;
            state.saved = fields;
            setStatus(`saved · v${data.draft.version}`);
            await refreshList();
            return;
        }

        const { res, data } = await api(`/api/drafts/${state.postId}/`, {
            method: "PUT", body: fields, etag: force ? state.conflict?.etag : state.etag, conflict: true,
        });

        if (res.status === 409) {
            // Never resolve this silently: both versions are real work, and
            // which one is "newer" is genuinely ambiguous — unsaved text on this
            // screen may have been typed after the other tab hit save.
            state.conflict = { etag: data.etag, draft: data.current };
            describeConflict(data.current);
            els.conflict.hidden = false;
            els.conflictKeep.focus();
            setStatus("conflict", "error");
            return;
        }

        state.etag = data.etag;
        state.version = data.draft.version;
        state.saved = fields;
        state.conflict = null;
        setStatus(`saved · v${data.draft.version}`);
        await refreshList();
    } catch (err) {
        if (err.message !== "unauthenticated") {
            setStatus("not saved", "error");
            setError(err.data?.fields
                ? Object.values(err.data.fields).join(" ")
                : err.message);
        }
    } finally {
        state.saving = false;
        els.save.disabled = false;
    }
}

// ---------------------------------------------------------------- attachments

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const setAttachStatus = (text) => { els.attachStatus.textContent = text; };

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "architecture-diagram.png" -> "architecture diagram", a starting point the author edits. */
function altFromName(name) {
    return String(name || "image").replace(/\.[^.]*$/, "").replace(/[-_]+/g, " ").trim() || "image";
}

/** The reference to type into the body, in whichever format the post is written. */
function referenceFor(attachment) {
    const latex = els.format.value === "latex";
    if (attachment.kind === "tex") {
        return latex ? `\\input{attachments/${attachment.id}.tex}` : `\n::tex[${attachment.id}]\n`;
    }
    const ext = attachment.publicName.split(".").pop();
    return latex
        ? `\\includegraphics{attachments/${attachment.id}.${ext}}`
        : `![${altFromName(attachment.originalName || attachment.publicName)}](attachment://${attachment.id})`;
}

function insertAtCursor(text) {
    const area = els.body;
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? start;
    area.setRangeText(text, start, end, "end");
    // Through the normal input path, so dirty-tracking notices the change.
    area.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Insert a reference on a line of its own, whatever the cursor was next to. */
function insertOnOwnLine(text) {
    const area = els.body;
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? start;
    const before = area.value.slice(0, start);
    const after = area.value.slice(end);
    const lead = before === "" || before.endsWith("\n") ? "" : "\n";
    const trail = after.startsWith("\n") ? "" : "\n";
    insertAtCursor(`${lead}${text.trim()}${trail}`);
}

async function loadAttachments() {
    state.attachments = [];
    if (state.postId) {
        const { data } = await api(`/api/uploads/?postId=${encodeURIComponent(state.postId)}`);
        state.attachments = data.attachments ?? [];
    }
    renderAttachments();
}

function renderAttachments() {
    els.attachmentList.replaceChildren();
    for (const attachment of state.attachments) {
        const li = document.createElement("li");
        li.className = "attachment";

        const name = document.createElement("span");
        name.className = "attachment-name";
        name.textContent = attachment.publicName;

        const meta = document.createElement("span");
        meta.className = "attachment-meta";
        meta.textContent = [
            attachment.kind === "tex" ? "TeX snippet" : attachment.mediaType.replace("image/", "").toUpperCase(),
            attachment.width ? `${attachment.width}×${attachment.height}` : null,
            formatBytes(attachment.bytes),
        ].filter(Boolean).join(" · ");

        const actions = document.createElement("span");
        actions.className = "attachment-actions";

        const insert = document.createElement("button");
        insert.type = "button";
        insert.className = "button button-secondary button-small";
        insert.textContent = "Insert";
        insert.addEventListener("click", () => { insertAtCursor(referenceFor(attachment)); els.body.focus(); });

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button button-danger button-small";
        remove.textContent = "Remove";
        remove.addEventListener("click", guard(() => removeAttachment(attachment)));

        actions.append(insert, remove);
        li.append(name, meta, actions);
        els.attachmentList.append(li);
    }
    // The preview shows attachments, so a change to them is a change to it.
    schedulePreview();
}

/**
 * Sign, transfer, verify.
 *
 * The bytes go straight to storage on a short-lived URL and never through the
 * server, which caps a request at 4.5 MB. The server then reads what arrived
 * and decides what it is — the type claimed here is only a first filter.
 */
async function uploadFile(file) {
    const isTex = /\.tex$/i.test(file.name || "");
    const ext = (file.name || "").split(".").pop().toLowerCase();
    const { data: signed } = await api("/api/uploads/", {
        method: "POST",
        body: {
            action: "sign",
            postId: state.postId,
            name: file.name || "pasted-image.png",
            size: file.size,
            type: isTex ? "text/x-tex" : (file.type || IMAGE_TYPES[ext] || ""),
            kind: isTex ? "tex" : "image",
        },
    });

    let put;
    try {
        put = await fetch(signed.url, { method: signed.method, headers: signed.headers, body: file });
    } catch {
        // fetch() rejects without a status when CORS blocks the request, so say
        // which of the likely causes it is rather than "Failed to fetch".
        throw new Error("The upload was blocked before it reached storage. " +
            "The storage bucket may not yet allow uploads from this site (CORS).");
    }
    if (!put.ok) throw new Error(`Storage refused the upload (${put.status}).`);

    const { data } = await api("/api/uploads/", {
        method: "POST", body: { action: "complete", postId: state.postId, uploadId: signed.uploadId },
    });
    return data.attachment;
}

async function attachFiles(files) {
    // Attachments belong to a saved draft, so a brand-new post is saved first.
    if (!state.postId) {
        await save();
        if (!state.postId) return; // the save failed; its error is already showing
    }
    try {
        for (const file of files) {
            setAttachStatus(`Uploading ${file.name || "image"}…`);
            const attachment = await uploadFile(file);
            state.attachments.push(attachment);
            renderAttachments();
            insertOnOwnLine(referenceFor(attachment));
        }
        setAttachStatus(files.length === 1 ? "Attached and inserted." : `Attached ${files.length} files.`);
    } catch (err) {
        setAttachStatus("");
        throw err;
    }
}

async function removeAttachment(attachment) {
    if (!confirm(`Remove ${attachment.publicName} from this draft? Pages already published keep their copy.`)) return;
    await api(`/api/uploads/?postId=${encodeURIComponent(state.postId)}&attachmentId=${encodeURIComponent(attachment.id)}`,
        { method: "DELETE" });
    await loadAttachments();
    setAttachStatus(`Removed ${attachment.publicName}. Delete its reference from the body too, or publishing will stop.`);
}

// ---------------------------------------------------------------- preview

const PREVIEW_DEBOUNCE_MS = 500;
// Signed image URLs in a preview last ten minutes; re-render before they lapse.
const PREVIEW_REFRESH_MS = 8 * 60 * 1000;

function setPreviewState(text, kind = "") {
    els.previewState.textContent = text;
    els.previewState.dataset.state = kind;
}

function showDiagnostics(list = []) {
    els.diagnostics.replaceChildren(...list.map((diagnostic) => {
        const li = document.createElement("li");
        li.className = `diagnostic diagnostic-${diagnostic.level}`;
        li.textContent = diagnostic.level === "error"
            ? `Will not publish: ${diagnostic.message}`
            : diagnostic.message;
        return li;
    }));
    els.diagnostics.hidden = list.length === 0;
}

/** Everything a render depends on, so an identical request is not repeated. */
const previewKey = () => JSON.stringify([readForm(), state.postId, state.attachments.map((a) => a.id)]);

function schedulePreview({ force = false } = {}) {
    if (!state.preview.open) return;
    clearTimeout(state.preview.timer);
    state.preview.timer = setTimeout(() => { refreshPreview({ force }); }, PREVIEW_DEBOUNCE_MS);
}

/**
 * Render on the server, show in the sandboxed frame.
 *
 * Only the newest request may paint. An older one still in flight is aborted,
 * and a response that arrives out of order is discarded by sequence number, so
 * a slow render can never overwrite a newer one.
 */
async function refreshPreview({ force = false } = {}) {
    if (!state.preview.open) return;
    const key = previewKey();
    if (!force && key === state.preview.lastKey) return;

    state.preview.controller?.abort();
    const controller = new AbortController();
    state.preview.controller = controller;
    const seq = ++state.preview.seq;
    setPreviewState("rendering…");

    try {
        const { data } = await api("/api/preview/", {
            method: "POST", body: { ...readForm(), postId: state.postId }, signal: controller.signal,
        });
        if (seq !== state.preview.seq) return;
        els.previewFrame.srcdoc = data.html;
        showDiagnostics(data.diagnostics);
        state.preview.lastKey = key;

        const errors = data.diagnostics.filter((d) => d.level === "error").length;
        const warnings = data.diagnostics.length - errors;
        if (errors) setPreviewState(`${errors} to fix before publishing`, "error");
        else if (warnings) setPreviewState(`${warnings} warning${warnings === 1 ? "" : "s"}`);
        else setPreviewState("up to date");
    } catch (err) {
        if (err.name === "AbortError" || seq !== state.preview.seq || err.message === "unauthenticated") return;
        setPreviewState(err.message || "Preview failed.", "error");
    }
}

function setPreviewOpen(open) {
    state.preview.open = open;
    els.previewPane.hidden = !open;
    els.writing.dataset.preview = open ? "on" : "off";
    els.previewToggle.setAttribute("aria-pressed", String(open));
    els.previewToggle.textContent = open ? "Hide preview" : "Preview";
    clearInterval(state.preview.refresher);
    clearTimeout(state.preview.timer);
    if (open) {
        state.preview.lastKey = null;
        refreshPreview();
        state.preview.refresher = setInterval(() => refreshPreview({ force: true }), PREVIEW_REFRESH_MS);
    } else {
        state.preview.controller?.abort();
    }
}

// ---------------------------------------------------------------- the site

// The server decides each state from the build manifest the site is serving
// (lib/server/deployments.mjs); these are only its names for the author.
const SITE_LABELS = {
    live: "Live", updating: "Updating", pending: "Not live yet",
    removing: "Coming down", offline: "Unpublished", unknown: "Not checked",
};
const UNSETTLED = new Set(["pending", "updating", "removing"]);
// After a change, check soon, then less often, and stop after a while: a build
// that has not landed in fifteen minutes has usually failed.
const WATCH_FIRST_MS = 4000;
const WATCH_MAX_MS = 30_000;
const WATCH_GIVE_UP_MS = 15 * 60 * 1000;
// Vercel allows 60 deploy-hook calls an hour; a pause stops repeated clicks spending them.
const REBUILD_PAUSE_MS = 30_000;

// Vercel's dashboard is where a build's own log lives, so point straight at it
// rather than saying "check Vercel" (CLAUDE.md Step 7).
function deploymentsLink() {
    const a = document.createElement("a");
    a.href = "https://vercel.com/blueshift/weblog/deployments";
    a.textContent = "The deployment list";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
}

async function refreshPublications() {
    const { data } = await api("/api/publish/");
    state.publications = data.publications ?? [];
    state.site = data.site ?? null;
    // Why the last build failed, if it did. The build itself writes this; the
    // panel shows it only while something has not landed, so a record left by
    // an older failure cannot contradict a site that has since caught up.
    state.buildFailure = data.buildFailure ?? null;
    renderPublications();
}

const publicationFor = (postId) => state.publications.find((p) => p.postId === postId) ?? null;
/** The publication the panel shows: one picked from the list, else the open draft's. */
const shownPublication = () => publicationFor(state.selected ?? state.postId);

const nameOf = (publication) => `“${publication.title || publication.slug}”`;
const revisionLabel = (revision) =>
    !revision ? "an earlier revision" : revision.version ? `revision ${revision.version}` : revision.revisionId;
const formatWhen = (iso) =>
    iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

function renderPublications() {
    const shown = shownPublication();
    els.publicationList.replaceChildren(...state.publications.map((publication) => {
        const button = document.createElement("button");
        button.type = "button";
        if (publication === shown) button.setAttribute("aria-current", "true");

        const title = document.createElement("span");
        title.className = "draft-title";
        title.textContent = publication.title || publication.slug;

        const meta = document.createElement("span");
        meta.className = "draft-meta";
        meta.textContent = `/${publication.slug}/ · ${SITE_LABELS[publication.site?.state] ?? SITE_LABELS.unknown}`;

        button.append(title, meta);
        button.addEventListener("click", guard(() => showPublication(publication.postId)));
        const li = document.createElement("li");
        li.append(button);
        return li;
    }));
    els.publicationEmpty.hidden = state.publications.length > 0;
    renderPanel();
}

/** A post picked from "On the site": its draft opens when it has one; the panel shows it either way. */
async function showPublication(postId) {
    if (postId !== state.postId && state.drafts.some((draft) => draft.postId === postId)) {
        await openDraft(postId);
    }
    // A draft that did not open, because unsaved changes were kept, leaves the
    // panel on the post that was asked for. The panel names its post.
    state.selected = postId === state.postId ? null : postId;
    renderPublications();
    els.publication.scrollIntoView({ block: "nearest", behavior: "instant" });
}

function renderPanel() {
    const publication = shownPublication();
    els.publication.hidden = !publication;
    if (!publication) return;

    const siteState = publication.site?.state ?? "unknown";
    els.publicationChip.textContent = SITE_LABELS[siteState];
    els.publicationChip.dataset.state = siteState;

    const revision = (id) => publication.revisions.find((r) => r.revisionId === id);
    const link = document.createElement("a");
    link.href = `/${publication.slug}/`;
    link.textContent = `/${publication.slug}/`;
    const words = (text) => document.createTextNode(text);
    const name = nameOf(publication);
    const summary = {
        live: [words(`${name} is live at `), link, words(`, showing ${revisionLabel(revision(publication.revisionId))}.`)],
        updating: [words(`${name} is published as ${revisionLabel(revision(publication.revisionId))}, but `), link,
            words(` still shows ${revisionLabel(revision(publication.site?.revisionId))} until the rebuild finishes.`)],
        pending: [words(`${name} is published, but `), link, words(" does not show it yet. Waiting for the rebuild…")],
        removing: [words(`${name} is unpublished, but `), link, words(" shows it until the rebuild finishes.")],
        offline: [words(`${name} is not on the site. Its revisions are kept for 90 days, so it can be put back.`)],
        unknown: [words(`${name} is ${publication.published ? "published at" : "unpublished from"} `), link,
            words(`. Whether the site shows that could not be checked: ${state.site?.reason ?? "no answer"}.`)],
    }[siteState];
    // A failed build never publishes a manifest, so waiting alone cannot tell a
    // broken build from a slow one. The build says which, and names the cause.
    const failure = UNSETTLED.has(siteState) ? state.buildFailure : null;
    if (failure) {
        summary.push(words(` The last build failed: ${failure.reason} `));
        summary.push(deploymentsLink());
        summary.push(words(" has the log. Fix the post, then publish again."));
    } else if (state.watch.gaveUp && UNSETTLED.has(siteState)) {
        summary.push(words(" Nothing has changed for 15 minutes and the build did not report a failure, "
            + "so it may have failed before it started. Check "));
        summary.push(deploymentsLink());
        summary.push(words(", then Rebuild site."));
    }
    els.publicationSummary.replaceChildren(...summary);

    // Rebuilt only when the choices change, so a check every few seconds does
    // not undo a revision the author is in the middle of picking.
    const select = els.publicationRevision;
    const signature = JSON.stringify([publication.postId, publication.revisionId,
        publication.lastPublishedRevisionId, publication.site?.revisionId,
        publication.revisions.map((r) => r.revisionId)]);
    if (select.dataset.signature !== signature) {
        const samePost = select.dataset.postId === publication.postId;
        // The author's own pick survives; a default does not, so publishing a
        // newer revision moves the choice to it rather than offering a rollback.
        const picked = samePost && select.value !== select.dataset.default ? select.value : null;
        // Once unpublished, the server remembers what was last on the site in
        // the same conditional write that removed it from the live index.
        const remembered = samePost && !publication.published ? select.dataset.default : null;
        const fallback = publication.revisionId ??
            (revision(remembered) ? remembered : null) ??
            (revision(publication.lastPublishedRevisionId)
                ? publication.lastPublishedRevisionId : publication.revisions[0]?.revisionId) ?? "";
        select.replaceChildren(...publication.revisions.map((stored) => {
            const marks = [
                stored.revisionId === publication.revisionId ? "published" : null,
                stored.revisionId === publication.site?.revisionId ? "on the site" : null,
            ].filter(Boolean);
            const option = document.createElement("option");
            option.value = stored.revisionId;
            option.textContent = `${revisionLabel(stored)} · ${formatWhen(stored.storedAt)}` +
                (marks.length ? ` (${marks.join(", ")})` : "");
            return option;
        }));
        select.value = revision(picked) ? picked : fallback;
        select.dataset.default = fallback;
        select.dataset.signature = signature;
        select.dataset.postId = publication.postId;
    }

    els.publicationRollback.textContent = publication.published ? "Roll back to this revision" : "Put back on the site";
    els.publicationRollback.disabled = !select.value || select.value === publication.revisionId;
    els.publicationUnpublish.hidden = !publication.published;
}

/**
 * Keep checking what the site shows while something is on its way.
 *
 * Resumes after a reload: whatever is still unsettled when the editor opens is
 * watched again. A site that could not be read is retried only after a change
 * the author made, and never where there is no site to ask.
 */
function watchSite({ restart = false } = {}) {
    const watch = state.watch;
    clearTimeout(watch.timer);
    if (restart) Object.assign(watch, { startedAt: Date.now(), delay: WATCH_FIRST_MS, gaveUp: false });

    const unsettled = state.publications.some((p) => UNSETTLED.has(p.site?.state)) ||
        Boolean(watch.startedAt && state.site && !state.site.ok && state.site.checkable);
    if (!unsettled) {
        watch.startedAt = null;
        renderPanel();
        return;
    }
    watch.startedAt ??= Date.now();
    watch.delay ||= WATCH_FIRST_MS;
    if (Date.now() - watch.startedAt > WATCH_GIVE_UP_MS) {
        watch.gaveUp = true;
        renderPanel();
        return;
    }
    watch.timer = setTimeout(async () => {
        try {
            await refreshPublications();
        } catch (err) {
            if (err.message === "unauthenticated") return;
            // A failed check is not a change; try again on the next tick.
        }
        watch.delay = Math.min(watch.delay * 2, WATCH_MAX_MS);
        watchSite();
    }, watch.delay);
}

/** Say what a change did to the site, including a rebuild that did not start. */
function reportChange(data) {
    setError(data.hookError ? `${data.hookError}. Use Rebuild site to try again.` : "");
}

async function unpublishShown() {
    const publication = shownPublication();
    if (!publication?.published) return;
    if (!confirm(`Take ${nameOf(publication)} off the site? /${publication.slug}/ stops showing it after the rebuild. ` +
        "Its revisions are kept, so it can be put back.")) return;
    const { data } = await api("/api/publish/", {
        method: "POST", body: { action: "unpublish", postId: publication.postId },
    });
    reportChange(data);
    await refreshPublications();
    watchSite({ restart: true });
}

async function rollbackShown() {
    const publication = shownPublication();
    const chosen = publication?.revisions.find((r) => r.revisionId === els.publicationRevision.value);
    if (!chosen) return;
    const verb = publication.published ? "Roll back" : "Put back";
    if (!confirm(`${verb} ${nameOf(publication)} to ${revisionLabel(chosen)}, stored ${formatWhen(chosen.storedAt)}? ` +
        `The site rebuilds to show it at /${publication.slug}/.`)) return;
    const { data } = await api("/api/publish/", {
        method: "POST", body: { action: "rollback", postId: publication.postId, revisionId: chosen.revisionId },
    });
    reportChange(data);
    await refreshPublications();
    watchSite({ restart: true });
}

async function rebuildSite() {
    els.publicationRebuild.disabled = true;
    setTimeout(() => { els.publicationRebuild.disabled = false; }, REBUILD_PAUSE_MS);
    els.rebuildNote.textContent = "Rebuilding…";
    const { data } = await api("/api/publish/", { method: "POST", body: { action: "rebuild" } });
    setError(data.triggered ? "" : `The rebuild could not be triggered: ${data.error}`);
    // Rebuilding also sweeps what no post needs any more. Say so only when it
    // actually removed something: "freed 0 KB" is noise on every other click.
    const swept = data.swept;
    els.rebuildNote.textContent = !data.triggered ? ""
        : swept?.objects
            ? `Rebuilding. Also removed ${swept.objects} unused object${swept.objects === 1 ? "" : "s"}` +
              `${swept.bytes ? ` (${(swept.bytes / 1024).toFixed(1)} KB)` : ""}.`
            : "Rebuilding. Nothing to clean up.";
    await refreshPublications();
    watchSite({ restart: true });
}

// ---------------------------------------------------------------- events

els.save.addEventListener("click", guard(() => save()));

els.publish.addEventListener("click", guard(async () => {
    // Publishing freezes a *saved* revision, so save first. Publishing what is
    // on screen while the store holds something older would put a version live
    // that the author never saw as saved.
    if (!state.postId || isDirty()) {
        await save();
        if (isDirty()) return; // the save failed; its error is already showing
    }

    els.publish.disabled = true;
    els.publishedNote.textContent = "";
    setStatus("publishing…");
    try {
        const { data } = await api("/api/publish/", {
            method: "POST", body: { postId: state.postId },
        });
        setStatus(`published · v${state.version}`);
        // Published is not live: the panel below says when the site shows it.
        els.publishedNote.textContent = data.job?.hookError
            ? "Published, but the rebuild was not triggered. Use Rebuild site to try again."
            : "Published. The site is rebuilding.";
        state.selected = null;
        await refreshPublications();
        watchSite({ restart: true });
    } finally {
        els.publish.disabled = false;
    }
}));
els.newPost.addEventListener("click", guard(newPost));

els.discard.addEventListener("click", guard(async () => {
    if (!state.postId) return newPost();
    if (!confirm("Delete this draft and all its revisions? This cannot be undone.")) return;
    await api(`/api/drafts/${state.postId}/`, { method: "DELETE" });
    state.saved = null; // the text on screen belonged to the draft just deleted
    await newPost();
    await refreshPublications();
}));

// A local escape hatch that never depends on the network or the session.
els.exportBtn.addEventListener("click", () => {
    const f = readForm();
    const front = [
        "---",
        `title: ${JSON.stringify(f.title)}`,
        `date: ${f.date}`,
        f.description ? `description: ${JSON.stringify(f.description)}` : null,
        f.tags.length ? `tags: [${f.tags.join(", ")}]` : null,
        "---",
        "",
    ].filter(Boolean).join("\n");

    const blob = new Blob([front + f.body + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slugify(f.slug || f.title) || "draft"}.${f.format === "latex" ? "tex" : "md"}`;
    link.click();
    URL.revokeObjectURL(url);
});

els.logout.addEventListener("click", guard(async () => {
    if (isDirty() && !confirm("This draft has unsaved changes. Sign out anyway?")) return;
    try { await api("/api/auth/logout/", { method: "POST" }); } catch { /* leaving regardless */ }
    window.location.href = "/login/";
}));

els.conflictKeep.addEventListener("click", guard(async () => {
    els.conflict.hidden = true;
    await save({ force: true });
}));

els.conflictTheirs.addEventListener("click", guard(async () => {
    els.conflict.hidden = true;
    if (state.conflict?.draft) {
        const loaded = state.conflict.draft;
        writeForm(loaded);
        state.etag = state.conflict.etag;
        state.version = loaded.version ?? null;
        state.saved = readForm();
        state.conflict = null;
        setStatus(loaded.version ? `saved · v${loaded.version}` : "loaded saved version");
    }
}));

for (const id of FIELDS) {
    els[id].addEventListener("input", () => {
        if (id === "title" || id === "slug") updateSlugPreview();
        if (isDirty()) setStatus("unsaved");
        schedulePreview();
    });
}

els.previewToggle.addEventListener("click", () => setPreviewOpen(!state.preview.open));

els.publicationRevision.addEventListener("change", () => renderPanel());
els.publicationRollback.addEventListener("click", guard(rollbackShown));
els.publicationRebuild.addEventListener("click", guard(rebuildSite));
els.publicationUnpublish.addEventListener("click", guard(unpublishShown));

els.attach.addEventListener("click", () => els.attachInput.click());

els.attachInput.addEventListener("change", guard(async () => {
    const files = [...els.attachInput.files];
    els.attachInput.value = ""; // choosing the same file again should fire change again
    if (files.length) await attachFiles(files);
}));

// preventDefault runs before the first await, so the browser's own paste and
// drop never happen alongside the upload.
els.body.addEventListener("paste", guard(async (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    await attachFiles(files);
}));

els.body.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes("Files")) {
        event.preventDefault();
        els.body.classList.add("drop-target");
    }
});
els.body.addEventListener("dragleave", () => els.body.classList.remove("drop-target"));
els.body.addEventListener("drop", guard(async (event) => {
    els.body.classList.remove("drop-target");
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    await attachFiles(files);
}));

// Ctrl/Cmd-S saves instead of invoking the browser's page-save dialog.
window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
    }
});

window.addEventListener("beforeunload", (event) => {
    if (isDirty()) event.preventDefault();
});

// ---------------------------------------------------------------- start

(async function start() {
  try {
    const res = await fetch("/api/auth/session/");
    const session = await res.json();
    if (!session.authenticated) {
        window.location.href = "/login/";
        return;
    }
    state.csrf = session.csrfToken;
    await newPost();
  } catch (err) {
    setStatus("failed", "error");
    setError(`Could not start the editor: ${err.message}`);
    return;
  }
  // Separately, so a site that cannot be checked never stops the editor opening.
  await guard(async () => {
    await refreshPublications();
    watchSite();
  })();
})();
