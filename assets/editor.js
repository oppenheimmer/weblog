// The editor client (CLAUDE.md Step 5, Slice 1).
//
// Deliberately small and dependency-free: a textarea, metadata fields, and
// conditional saves. Preview and attachments arrive in later slices.
const $ = (id) => document.getElementById(id);

const els = {
    saveState: $("save-state"), draftList: $("draft-list"), draftEmpty: $("draft-empty"),
    title: $("title"), date: $("date"), format: $("format"), slug: $("slug"),
    slugPreview: $("slug-preview"), description: $("description"), tags: $("tags"),
    body: $("body"), save: $("save"), newPost: $("new-post"), logout: $("logout"),
    discard: $("discard"), exportBtn: $("export"), error: $("editor-error"),
    conflict: $("conflict"), conflictKeep: $("conflict-keep"), conflictTheirs: $("conflict-theirs"),
};

const state = {
    csrf: null,
    postId: null,
    etag: null,
    // What was last persisted, so "unsaved" is a real comparison rather than a
    // flag that drifts out of sync with the fields.
    saved: null,
    conflict: null,
    saving: false,
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
    writeForm(data.draft);
    state.saved = readForm();
    setStatus(`saved · v${data.draft.version}`);
    setError("");
    await refreshList();
}

async function newPost() {
    if (isDirty() && !confirm("This draft has unsaved changes. Discard them?")) return;
    state.postId = null;
    state.etag = null;
    writeForm({ date: new Date().toISOString().slice(0, 10) });
    state.saved = readForm();
    setStatus("not saved");
    setError("");
    await refreshList();
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
            state.saved = fields;
            setStatus(`saved · v${data.draft.version}`);
            await refreshList();
            return;
        }

        const { res, data } = await api(`/api/drafts/${state.postId}/`, {
            method: "PUT", body: fields, etag: force ? state.conflict?.etag : state.etag,
        });

        if (res.status === 409) {
            // Never resolve this silently: both versions are real work.
            state.conflict = { etag: data.etag, draft: data.current };
            els.conflict.hidden = false;
            els.conflictKeep.focus();
            setStatus("conflict", "error");
            return;
        }

        state.etag = data.etag;
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

// ---------------------------------------------------------------- events

els.save.addEventListener("click", guard(() => save()));
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
        writeForm(state.conflict.draft);
        state.etag = state.conflict.etag;
        state.saved = readForm();
        state.conflict = null;
        setStatus("loaded newer version");
    }
}));

for (const id of FIELDS) {
    els[id].addEventListener("input", () => {
        if (id === "title" || id === "slug") updateSlugPreview();
        if (isDirty()) setStatus("unsaved");
    });
}

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
