(() => {
    const STORAGE_KEY = "school-theme";
    const THEME_IDS = new Set(["theme-light", "theme-dark", "theme-contrast"]);
    const THEME_REVEAL_COLORS = {
        "theme-light": "#f3efe8",
        "theme-dark": "#161d1b",
        "theme-contrast": "#000000"
    };

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

    const keepScrollPosition = (top) => {
        window.requestAnimationFrame(() => {
            window.scrollTo({ top, behavior: "auto" });
        });
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
                if (input.checked) {
                    const scrollTop = window.scrollY;
                    saveTheme(input.id);
                    launchThemeReveal(input.id, themeSwitcher, reduceMotionQuery);
                    keepScrollPosition(scrollTop);
                }
            });
        });

        window.addEventListener("storage", (event) => {
            if (event.key !== STORAGE_KEY) return;
            applyTheme(readSavedTheme() || "", inputs);
        });
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initThemePersistence, { once: true });
    } else {
        initThemePersistence();
    }
})();
