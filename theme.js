(() => {
    const STORAGE_KEY = "school-theme";
    const THEME_IDS = new Set(["theme-light", "theme-dark", "theme-contrast"]);
    const THEME_REVEAL_COLORS = {
        "theme-light": "#f3efe8",
        "theme-dark": "#161d1b",
        "theme-contrast": "#000000"
    };
    const MOBILE_HEADER_BREAKPOINT = 760;

    const readSavedTheme = () => {
        try {
            const value = window.localStorage.getItem(STORAGE_KEY);
            return THEME_IDS.has(value) ? value : null;
        } catch {
            return null;
        }
    };

    const saveTheme = (themeId) => {
        if (!THEME_IDS.has(themeId)) return;
        try {
            window.localStorage.setItem(STORAGE_KEY, themeId);
        } catch {
            // ignore write errors (private mode, disabled storage)
        }
    };

    const applyTheme = (themeId, inputs) => {
        if (!THEME_IDS.has(themeId)) return false;
        const target = inputs.find((input) => input.id === themeId);
        if (!target) return false;
        target.checked = true;
        return true;
    };

    const keepScrollPosition = (top) => {
        window.requestAnimationFrame(() => {
            window.scrollTo({ top, behavior: "auto" });
        });
    };

    const launchThemeReveal = (themeId, themeSwitcher, reduceMotionQuery) => {
        if (!themeSwitcher || reduceMotionQuery.matches) return;

        const rect = themeSwitcher.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const maxX = Math.max(centerX, window.innerWidth - centerX);
        const maxY = Math.max(centerY, window.innerHeight - centerY);
        const radius = Math.hypot(maxX, maxY);

        const reveal = document.createElement("span");
        reveal.className = "theme-reveal";
        reveal.style.left = `${centerX}px`;
        reveal.style.top = `${centerY}px`;
        reveal.style.setProperty("--theme-reveal-size", `${radius * 2}px`);
        reveal.style.background = THEME_REVEAL_COLORS[themeId] ?? THEME_REVEAL_COLORS["theme-light"];
        document.body.append(reveal);

        requestAnimationFrame(() => reveal.classList.add("is-active"));
        reveal.addEventListener("transitionend", () => reveal.remove(), { once: true });
    };

    const initThemePersistence = () => {
        const inputs = Array.from(document.querySelectorAll('input.theme-toggle[name="theme"]'));
        if (inputs.length === 0) return;

        const themeSwitcher = document.querySelector(".theme-switcher");
        const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
        const labels = Array.from(document.querySelectorAll('.theme-options label[for^="theme-"]'));

        const savedTheme = readSavedTheme();
        if (!applyTheme(savedTheme || "", inputs)) {
            const checked = inputs.find((input) => input.checked);
            if (checked && THEME_IDS.has(checked.id)) {
                saveTheme(checked.id);
            }
        }

        labels.forEach((label) => {
            label.addEventListener("click", (event) => {
                const inputId = label.getAttribute("for");
                if (!inputId || !THEME_IDS.has(inputId)) return;

                const targetInput = inputs.find((input) => input.id === inputId);
                if (!targetInput) return;

                event.preventDefault();
                const scrollTop = window.scrollY;
                const changed = !targetInput.checked;
                targetInput.checked = true;

                if (changed) {
                    targetInput.dispatchEvent(new Event("change", { bubbles: true }));
                } else {
                    keepScrollPosition(scrollTop);
                }
            });
        });

        inputs.forEach((input) => {
            input.addEventListener("change", () => {
                if (!input.checked) return;
                const scrollTop = window.scrollY;
                saveTheme(input.id);
                launchThemeReveal(input.id, themeSwitcher, reduceMotionQuery);
                keepScrollPosition(scrollTop);
            });
        });

        window.addEventListener("storage", (event) => {
            if (event.key !== STORAGE_KEY) return;
            applyTheme(readSavedTheme() || "", inputs);
        });
    };

    const initMobileHeaderToggle = () => {
        const header = document.querySelector(".site-header");
        if (!header) return;

        const toggle = header.querySelector(".header-toggle");
        const controls = header.querySelector(".header-controls");
        if (!toggle || !controls) return;

        const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_HEADER_BREAKPOINT}px)`);
        const expandLabel = toggle.dataset.expandLabel || "Expand";
        const collapseLabel = toggle.dataset.collapseLabel || "Collapse";

        const setExpanded = (expanded) => {
            const nextState = Boolean(expanded && mobileQuery.matches);
            header.classList.toggle("is-expanded", nextState);
            toggle.setAttribute("aria-expanded", nextState ? "true" : "false");
            toggle.textContent = nextState ? collapseLabel : expandLabel;
        };

        const syncMobileState = () => {
            toggle.hidden = !mobileQuery.matches;
            if (!mobileQuery.matches) {
                setExpanded(false);
                return;
            }
            setExpanded(header.classList.contains("is-expanded"));
        };

        const closeMenu = () => setExpanded(false);

        toggle.addEventListener("click", () => {
            setExpanded(!header.classList.contains("is-expanded"));
        });

        controls.addEventListener("click", (event) => {
            if (event.target.closest("a")) closeMenu();
        });

        document.addEventListener("click", (event) => {
            if (!mobileQuery.matches || !header.classList.contains("is-expanded")) return;
            if (header.contains(event.target)) return;
            closeMenu();
        });

        window.addEventListener("keydown", (event) => {
            if (event.key === "Escape") closeMenu();
        });

        mobileQuery.addEventListener("change", syncMobileState);
        syncMobileState();
    };

    const init = () => {
        initThemePersistence();
        initMobileHeaderToggle();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();
