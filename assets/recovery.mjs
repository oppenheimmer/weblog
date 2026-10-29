// Supplemental device copies. Never store credentials, assets or server records.
export const RECOVERY_TTL_MS = 7 * 86400_000;
export const RECOVERY_MAX_COPIES = 10;
export const RECOVERY_MAX_BYTES = 10 * 1024 * 1024;
export const SAVE_TIMEOUT_MS = 15_000;
export const RETRY_DELAYS_MS = [2000, 4000, 8000];
export const newCreationId = () => `${Date.now()}-${crypto.randomUUID()}`;
export const transientSaveError = (err) => err.name === "TypeError" || err.name === "TimeoutError" ||
    [408, 429, 500, 502, 503, 504].includes(err.status);

export function sourceFields(value = {}) {
    return Object.fromEntries(["title", "date", "format", "slug", "description", "tags", "body"]
        .map((key) => [key, key === "tags" ? [...(value.tags ?? [])].map(String) : String(value[key] ?? (key === "format" ? "markdown" : ""))]));
}
export const sameFields = (a, b) => JSON.stringify(sourceFields(a)) === JSON.stringify(sourceFields(b));

// Abort covers headers AND response-body consumption. Invalid/truncated success
// bodies are failures too: a POST may have committed before its response broke.
export async function requestJson(url, options = {}, timeout = SAVE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("The save request timed out.", "TimeoutError")), timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
        const res = await fetch(url, { ...options, signal });
        let data;
        try { data = await res.json(); }
        catch (err) {
            signal.throwIfAborted();
            if (res.ok) throw new TypeError("The server response was interrupted. Your text is still here.");
            data = {};
        }
        return { res, data };
    } finally { clearTimeout(timer); }
}

const result = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

export function createRecoveryStore() {
    let opened;
    function open() {
        return opened ??= new Promise((resolve, reject) => {
            const request = indexedDB.open("weblog-editor-recovery", 1);
            let expired = false;
            const timer = setTimeout(() => { expired = true; reject(new Error("Device storage did not respond.")); }, 4000);
            request.onupgradeneeded = () => {
                request.result.createObjectStore("copies", { keyPath: "id" });
                request.result.createObjectStore("settings", { keyPath: "key" });
            };
            request.onsuccess = () => {
                clearTimeout(timer);
                if (expired) { request.result.close(); return; }
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            };
            request.onerror = () => { clearTimeout(timer); reject(request.error); };
            request.onblocked = () => { clearTimeout(timer); expired = true; reject(new Error("Close older editor tabs to enable device recovery.")); };
        });
    }
    async function change(fn) {
        const db = await open();
        const tx = db.transaction(["copies", "settings"], "readwrite");
        let timedOut = false;
        const deadline = setTimeout(() => { timedOut = true; try { tx.abort(); } catch { /* already finished */ } }, 4000);
        const complete = new Promise((resolve, reject) => {
            tx.oncomplete = () => { clearTimeout(deadline); resolve(); };
            tx.onabort = () => {
                clearTimeout(deadline);
                reject(timedOut ? new Error("Device storage did not respond.") : tx.error ?? new Error("Device storage did not commit."));
            };
            tx.onerror = () => {}; // onabort carries the transaction's result
        });
        // Attach immediately: an application-level limit can abort before await.
        complete.catch(() => {});
        try {
            const copies = tx.objectStore("copies"), settings = tx.objectStore("settings");
            const [all, stored] = await Promise.all([result(copies.getAll()), result(settings.get("preferences"))]);
            const prefs = stored ?? { key: "preferences", enabled: true, locked: false };
            const live = all.filter((copy) => Number.isFinite(copy.updatedAt) && Date.now() - copy.updatedAt < RECOVERY_TTL_MS);
            for (const copy of all) if (!live.includes(copy)) copies.delete(copy.id);
            const value = fn({ copies, settings, prefs, live });
            await complete;
            return value;
        } catch (err) { try { tx.abort(); } catch { /* already complete */ } throw err; }
    }
    return {
        list: () => change(({ live, prefs }) => ({ copies: live.sort((a, b) => b.updatedAt - a.updatedAt), enabled: prefs.enabled, locked: prefs.locked })),
        unlock: () => change(({ settings, prefs }) => { settings.put({ ...prefs, locked: false }); }),
        put: (input) => {
            const copy = {
                id: input.id, postId: input.postId, etag: input.etag, version: input.version,
                fields: sourceFields(input.fields), base: sourceFields(input.base), updatedAt: Date.now(),
                creation: input.creation ? { requestId: input.creation.requestId, fields: sourceFields(input.creation.fields) } : null,
            };
            const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
            return change(({ copies, prefs, live }) => {
                if (!prefs.enabled || prefs.locked) return false;
                const others = live.filter((item) => item.id !== copy.id);
                if (others.length >= RECOVERY_MAX_COPIES || others.reduce((sum, item) => sum + bytes(item), bytes(copy)) > RECOVERY_MAX_BYTES) {
                    throw new Error("Device recovery is full (10 copies or 10 MiB). Export or discard old copies to make room.");
                }
                copies.put(copy);
                return true;
            });
        },
        remove: (id) => change(({ copies }) => { copies.delete(id); }),
        clear: () => change(({ copies }) => { copies.clear(); }),
        enable: (enabled) => change(({ copies, settings, prefs }) => {
            settings.put({ ...prefs, enabled });
            if (!enabled) copies.clear();
        }),
        lock: () => change(({ copies, settings, prefs }) => {
            copies.clear(); settings.put({ ...prefs, locked: true });
        }),
    };
}
