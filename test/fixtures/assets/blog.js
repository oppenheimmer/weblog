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

    // Clickable database rows: the row is a <div>; the title holds the real link
    // (so tag chips can be their own links without nesting anchors). Clicking
    // anywhere on the row that isn't a real link navigates to the post.
    document.querySelectorAll(".db-row").forEach(function (row) {
        var link = row.querySelector(".db-title a");
        if (!link) return;
        row.addEventListener("click", function (e) {
            if (e.target.closest("a")) return; // let title/tag links act normally
            window.location.href = link.href;
        });
    });

    // Scroll-triggered reveal (ported from the main site).
    var fadeEls = document.querySelectorAll(".fade-up");
    if ("IntersectionObserver" in window) {
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add("is-visible");
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.1 });
        fadeEls.forEach(function (el) { observer.observe(el); });
    } else {
        fadeEls.forEach(function (el) { el.classList.add("is-visible"); });
    }
})();
