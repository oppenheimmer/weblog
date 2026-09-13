// The figure loader for Run preview (CLAUDE.md §3.6).
//
// assets/blog.js imports a figure only from /assets/figures/, where publishing
// puts one, and that rule stays exactly as published pages have it. A figure
// being previewed has no public copy yet; lib/server/preview.mjs points it at a
// grant to its unpublished bundle and adds this file, only when the author asks
// to run the preview. Labs need nothing here: blog.js frames any same-origin
// address in the sandbox it gives published labs.
//
// The contract is the published one — vendored dependencies by name, then
// `mount(root, context)` with the fallback kept until it returns — so a figure
// that runs here runs the same way on its post page. It runs inside the
// editor's preview frame, which is sandboxed without an origin of its own: the
// figure has the previewed article, and not the editor.
(function () {
    "use strict";

    if (!document.body.classList.contains("post-page")) return;

    // Kept equal to VENDORED_SOURCES in lib/interactives.mjs by a test.
    var vendored = {};
    var VENDORED_SOURCES = { distill: "/assets/vendor/distill.template.v2.js", d3: "/assets/vendor/d3.v7.9.0.min.js" };

    function loadVendored(name) {
        if (!Object.prototype.hasOwnProperty.call(VENDORED_SOURCES, name)) {
            return Promise.reject(new Error("this engine does not vendor " + name));
        }
        if (vendored[name]) return vendored[name];
        vendored[name] = new Promise(function (resolve, reject) {
            var tag = document.createElement("script");
            tag.src = VENDORED_SOURCES[name];
            tag.onload = resolve;
            tag.onerror = function () { reject(new Error("could not load " + name)); };
            document.head.appendChild(tag);
        });
        return vendored[name];
    }

    document.querySelectorAll('figure[data-interactive="figure"]').forEach(function (figure) {
        var src = figure.getAttribute("data-interactive-src");
        var root = figure.querySelector(".interactive-root");
        if (!src || src.indexOf("/api/preview/run/") !== 0 || !root) return;

        var deps = (figure.getAttribute("data-interactive-deps") || "").split(/\s+/).filter(Boolean);
        Promise.all(deps.map(loadVendored)).then(function () {
            // Absolute, not the root-relative address: this script runs in a
            // frame with an opaque origin, where Chromium treats it as
            // CORS-cross-origin and resolves its import() against about:blank.
            return import(new URL(src, document.baseURI).href);
        }).then(function (module) {
            if (typeof module.mount !== "function") {
                throw new Error("a figure exports no mount(root, context)");
            }
            return module.mount(root, {
                theme: document.documentElement.getAttribute("data-theme") || "light",
                reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                width: root.clientWidth
            });
        }).then(function () {
            figure.classList.add("interactive--live");
        }).catch(function (err) {
            figure.classList.add("interactive--failed");
            if (window.console) console.error("figure failed to mount:", src, err);
            // Readers get the fallback quietly; the author, previewing, is told.
            var note = document.createElement("p");
            note.className = "interactive-run-error";
            note.style.color = "#b42318";
            note.textContent = "Run preview: this figure did not mount. " + (err && err.message ? err.message : String(err));
            figure.appendChild(note);
        });
    });
})();
