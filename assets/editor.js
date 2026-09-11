// The editor client (CLAUDE.md Step 5, Slice 1).
//
// Deliberately small and dependency-free: a textarea, metadata fields,
// conditional saves, and attachments uploaded straight to storage. Preview
// arrives in a later slice.
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

/** Every request carries the CSRF token; reads simply ignore it. */
async function api(path, { method = "GET", body, etag } = {}) {
    const headers = { "content-type": "application/json" };
    if (state.csrf) headers["x-csrf-token"] = state.csrf;
    if (etag) headers["if-match"] = etag;

    const res = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401) {
        // The session went away. Do not silently discard what is on screen.
        setStatus("signed out", "error");
        setError("Your session ended. Export your text, then sign in again.");
        throw new Error("unauthenticated");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) {
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
}

async function openDraft(postId) {
    if (isDirty() && !confirm("This draft has unsaved changes. Discard them?")) return;
    const { data } = await api(`/api/drafts/${postId}/`);
    state.postId = data.draft.postId;
    state.etag = data.etag;
    state.version = data.draft.version;
    writeForm(data.draft);
    state.saved = readForm();
    await loadAttachments();
    setStatus(`saved · v${data.draft.version}`);
    setError("");
    await refreshList();
}

async function newPost() {
    if (isDirty() && !confirm("This draft has unsaved changes. Discard them?")) return;
    state.postId = null;
    state.etag = null;
    state.version = null;
    writeForm({ date: new Date().toISOString().slice(0, 10) });
    state.saved = readForm();
    await loadAttachments();
    setStatus("not saved");
    setError("");
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
            method: "PUT", body: fields, etag: force ? state.conflict?.etag : state.etag,
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
            insertAtCursor(referenceFor(attachment));
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

        const link = document.createElement("a");
        link.href = data.url;
        link.textContent = data.url;
        els.publishedNote.replaceChildren(
            document.createTextNode(
                data.job?.hookError
                    ? "Published, but the rebuild was not triggered. It will appear on the next build: "
                    : "Published. The site is rebuilding; it will appear shortly at "
            ),
            link
        );
    } finally {
        els.publish.disabled = false;
    }
}));
els.newPost.addEventListener("click", guard(newPost));

els.discard.addEventListener("click", guard(async () => {
    if (!state.postId) return newPost();
    if (!confirm("Delete this draft and all its revisions? This cannot be undone.")) return;
    await api(`/api/drafts/${state.postId}/`, { method: "DELETE" });
    await newPost();
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
    });
}

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
  }
})();
