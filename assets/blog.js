(function () {
    "use strict";

    // Clone desktop nav + social into the mobile menu (ported from the main site).
    var mobileMenu = document.getElementById("mobile-menu");
    if (mobileMenu) {
        mobileMenu.querySelectorAll("[data-clone-source]").forEach(function (target) {
            var source = document.querySelector("." + target.getAttribute("data-clone-source"));
            if (source) {
                target.innerHTML = source.innerHTML;
            }
        });
    }

    var copyrightYear = document.getElementById("copyright-year");
    if (copyrightYear) {
        copyrightYear.textContent = new Date().getFullYear();
    }

    var mobileMenuBtn = document.getElementById("mobile-menu-btn");
    var mobileMenuIconOpen = document.getElementById("mobile-menu-icon-open");
    var mobileMenuIconClose = document.getElementById("mobile-menu-icon-close");

    if (mobileMenuBtn && mobileMenu && mobileMenuIconOpen && mobileMenuIconClose) {
        function setMobileMenuState(isOpen) {
            mobileMenu.hidden = !isOpen;
            mobileMenuBtn.setAttribute("aria-expanded", String(isOpen));
            mobileMenuBtn.setAttribute("aria-label", isOpen ? "Close navigation menu" : "Open navigation menu");
            mobileMenuIconOpen.hidden = isOpen;
            mobileMenuIconClose.hidden = !isOpen;
        }

        mobileMenuBtn.addEventListener("click", function () {
            setMobileMenuState(mobileMenuBtn.getAttribute("aria-expanded") !== "true");
        });

        mobileMenu.querySelectorAll("a").forEach(function (link) {
            link.addEventListener("click", function () {
                setMobileMenuState(false);
            });
        });
    }

    // Feed/table switch on listing pages. The head script has already shown the
    // reader's choice before first paint (lib/templates.mjs); this keeps the
    // buttons truthful and remembers a new choice.
    var VIEW_KEY = "blog:view";
    var root = document.documentElement;
    var viewButtons = document.querySelectorAll("[data-view-option]");

    function showView(view) {
        if (view === "table") root.setAttribute("data-view", "table");
        else root.removeAttribute("data-view");
        viewButtons.forEach(function (button) {
            button.setAttribute("aria-pressed", String(button.getAttribute("data-view-option") === view));
        });
    }

    if (viewButtons.length) {
        showView(root.getAttribute("data-view") === "table" ? "table" : "feed");
        viewButtons.forEach(function (button) {
            button.addEventListener("click", function () {
                var view = button.getAttribute("data-view-option");
                showView(view);
                var stored = false;
                try {
                    localStorage.setItem(VIEW_KEY, view);
                    stored = true;
                } catch (e) { /* storage refused; the address carries the choice instead */ }
                // A ?view= in the address outranks storage on the next load, so
                // it must agree with this choice: dropped once storage holds it,
                // kept in its place when storage is refused.
                try {
                    var url = new URL(window.location.href);
                    if (stored) url.searchParams.delete("view");
                    else url.searchParams.set("view", view);
                    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
                } catch (e) { /* the view still switched; only the reload memory is lost */ }
            });
        });
    }

    // Clickable table rows: the title holds the real link, so tag chips can be
    // links of their own without nesting anchors. Clicking anywhere else on the
    // row goes to the post, unless the reader was selecting text.
    document.querySelectorAll(".post-table tbody tr").forEach(function (row) {
        var link = row.querySelector(".post-table-title a");
        if (!link) return;
        row.addEventListener("click", function (e) {
            if (e.target.closest("a")) return;
            if (window.getSelection && String(window.getSelection())) return;
            window.location.href = link.href;
        });
    });

    // Scroll-triggered reveal (ported from the main site).
    //
    // Threshold 0: reveal as soon as any part is on screen. The main site's 0.1
    // meant "a tenth of the element is visible", which an element more than ten
    // screens tall can never be, and Chromium then never reports it as
    // intersecting at all. A long post's body, or a long article in the feed,
    // stayed invisible however far the reader scrolled.
    var fadeEls = document.querySelectorAll(".fade-up");
    if ("IntersectionObserver" in window) {
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add("is-visible");
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0 });
        fadeEls.forEach(function (el) { observer.observe(el); });
    } else {
        fadeEls.forEach(function (el) { el.classList.add("is-visible"); });
    }

    // Interactive labs (CLAUDE.md §3.6).
    //
    // The published page carries only the fallback. The iframe is built here,
    // and only on a post's own page, which is what makes three of §3.6's rules
    // true at once: a listing shows the fallback and runs nothing, a reader
    // without JavaScript gets the fallback rather than an empty rectangle, and
    // the sandbox attributes live in one place a tripwire can pin rather than
    // being frozen into revisions published before the rules last changed.
    //
    // `allow-same-origin` is never granted. Without it the lab has an opaque
    // origin and cannot read this document or its cookies; the response header
    // on /demos/ says the same thing again, for the case where someone opens
    // the lab's URL directly instead of letting this code frame it.
    if (document.body.classList.contains("post-page")) {
        document.querySelectorAll('figure[data-interactive="demo"]').forEach(function (figure) {
            var src = figure.getAttribute("data-interactive-src");
            if (!src || src.charAt(0) !== "/") return;

            var frame = document.createElement("iframe");
            frame.className = "interactive-frame";
            frame.setAttribute("sandbox", "allow-scripts");
            frame.setAttribute("referrerpolicy", "no-referrer");
            frame.setAttribute("loading", "lazy");
            frame.setAttribute("title", figure.getAttribute("data-interactive-name") || "Interactive");
            frame.src = src;
            figure.insertBefore(frame, figure.firstChild);
            figure.classList.add("interactive--live");

            // The bridge, deliberately tiny (§3.6): presentation only, one
            // version, and every message checked for source window, shape and
            // bounds before it changes anything. A lab can ask for its own
            // height and be told the reader's preferences; it can say nothing
            // else, and nothing it says reaches the rest of the page.
            frame.addEventListener("load", function () {
                try {
                    frame.contentWindow.postMessage({
                        weblog: 1,
                        type: "context",
                        theme: document.documentElement.getAttribute("data-theme") || "light",
                        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                    }, "*");
                } catch (e) { /* a lab that will not listen is still a lab */ }
            });

            window.addEventListener("message", function (event) {
                if (event.source !== frame.contentWindow) return;
                var data = event.data;
                if (!data || data.weblog !== 1 || data.type !== "height") return;
                var height = Number(data.height);
                if (!isFinite(height) || height < 40 || height > 4000) return;
                frame.style.height = Math.round(height) + "px";
            });
        });
    }
})();
