(() => {
    "use strict";
    const $ = (id) => document.getElementById(id);
    const token = document.querySelector('meta[name="explorer-token"]').content;
    const collator = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
    });
    const preferenceKey = "explorer.preferences";
    const RECYCLE_BIN = "recycle-bin";
    const inRecycleBin = () => state.path === RECYCLE_BIN;
    const state = {
        path: null,
        parent: null,
        breadcrumbs: [],
        items: [],
        ordered: [],
        drives: [],
        shortcuts: [],
        query: "",
        history: [],
        historyIndex: -1,
        selected: new Set(),
        focus: null,
        anchor: null,
        clipboard: null,
        loading: false,
        working: false,
        request: 0,
        controller: null,
        view: "details",
        sort: "name",
        direction: "asc",
        hidden: false,
        errors: [],
        truncated: false,
        scanned: 0,
        preview: null,
        previewId: 0,
        busy: new Map(),
        modalResolve: null,
        typeAhead: "",
        typeTime: 0,
    };
    try {
        const saved = JSON.parse(localStorage.getItem(preferenceKey) || "{}");
        if (["details", "grid"].includes(saved.view)) state.view = saved.view;
        if (["name", "modified", "type", "size"].includes(saved.sort))
            state.sort = saved.sort;
        if (["asc", "desc"].includes(saved.direction))
            state.direction = saved.direction;
        state.hidden = saved.hidden === true;
    } catch (_) {
        /* Preferences are optional. */
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function icon(name, small = false) {
        const node = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg",
        );
        node.setAttribute("class", small ? "icon small" : "icon");
        node.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "use",
        );
        use.setAttribute("href", `#i-${name}`);
        node.append(use);
        return node;
    }
    function button(label, handler, className = "") {
        const node = element("button", className, label);
        node.type = "button";
        if (handler) node.addEventListener("click", handler);
        return node;
    }
    function url(route, values = {}) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(values)) {
            if (value !== undefined && value !== null)
                query.set(key, String(value));
        }
        return route + (query.size ? `?${query}` : "");
    }
    async function api(route, options = {}) {
        const headers = new Headers(options.headers || {});
        headers.set("X-Explorer-Token", token);
        if (options.body && !(options.body instanceof FormData))
            headers.set("Content-Type", "application/json");
        let response;
        try {
            response = await fetch(route, {
                ...options,
                headers,
                credentials: "same-origin",
            });
        } catch (error) {
            if (error.name === "AbortError") throw error;
            throw new Error("Cannot reach the local file service.");
        }
        let data;
        try {
            data = await response.json();
        } catch (_) {
            throw new Error(
                `The file service returned an invalid response (HTTP ${response.status}).`,
            );
        }
        if (response.status === 401 && data.code === "authentication_required") {
            window.location.replace("/login");
        }
        if (!response.ok) {
            const error = new Error(
                data.error || `Request failed (HTTP ${response.status}).`,
            );
            error.status = response.status;
            error.code = data.code;
            error.conflicts = data.conflicts || [];
            throw error;
        }
        return data;
    }
    const post = (route, data) =>
        api(route, { method: "POST", body: JSON.stringify(data) });
    function bytes(value) {
        if (
            value === null ||
            value === undefined ||
            !Number.isFinite(Number(value))
        )
            return "Unknown";
        const size = Math.max(0, Number(value));
        if (size < 1024) return `${size} B`;
        const units = ["KB", "MB", "GB", "TB", "PB"];
        const power = Math.min(
            Math.floor(Math.log(size) / Math.log(1024)),
            units.length,
        );
        return `${(size / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[power - 1]}`;
    }
    function date(value) {
        if (value === null || value === undefined) return "Unknown";
        const result = new Date(value * 1000);
        return Number.isNaN(result.getTime())
            ? "Unknown"
            : result.toLocaleString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
              });
    }
    function basename(path) {
        return (
            String(path || "")
                .replace(/[\\/]+$/, "")
                .split(/[\\/]/)
                .pop() || "This PC"
        );
    }
    function extension(item) {
        return String(item.extension || item.name.split(".").pop() || "")
            .replace(/^\./, "")
            .toLowerCase();
    }
    function kindIcon(item) {
        if (item.is_dir) return "folder";
        if (/^(png|jpg|jpeg|gif|webp|bmp|ico|avif|svg)$/.test(extension(item)))
            return "image";
        if (
            /^(mp4|webm|mov|m4v|mkv|mp3|wav|ogg|m4a|flac|aac)$/.test(
                extension(item),
            )
        )
            return "media";
        return "file";
    }
    function selectedItems() {
        return state.items.filter((item) => state.selected.has(item.path));
    }
    function savePreferences() {
        try {
            localStorage.setItem(
                preferenceKey,
                JSON.stringify({
                    view: state.view,
                    sort: state.sort,
                    direction: state.direction,
                    hidden: state.hidden,
                }),
            );
        } catch (_) {
            /* The application works without browser storage. */
        }
    }
    function busy(label) {
        const id = Symbol(label);
        state.busy.set(id, label);
        updateBusy();
        return () => {
            state.busy.delete(id);
            updateBusy();
        };
    }
    function updateBusy() {
        $("busy-status").textContent = [...state.busy.values()].at(-1) || "";
        $("main").setAttribute("aria-busy", String(state.loading));
    }
    function notify(message, isError = false, errors = []) {
        $("notice-text").textContent = message;
        $("notice").classList.toggle("error", isError);
        $("notice").hidden = false;
        $("notice-details").hidden = errors.length === 0;
        $("notice-details").onclick = () => showErrors(errors);
    }
    function reportError(error) {
        if (error.name !== "AbortError")
            notify(error.message || "Operation failed.", true);
    }
    function showErrors(errors) {
        const body = element("div");
        const list = element("ul");
        errors.forEach((error) =>
            list.append(
                element(
                    "li",
                    "",
                    `${error.path || "Item"}: ${error.error || "Unavailable"}`,
                ),
            ),
        );
        body.append(list);
        return showModal("Operation details", body, [
            { label: "Close", value: false },
        ]);
    }

    function showModal(title, content, choices, focusInput = null) {
        if ($("modal").open) finishModal(null);
        $("modal-title").textContent = title;
        $("modal-content").replaceChildren(content);
        $("modal-actions").replaceChildren();
        for (const choice of choices) {
            const node = button(
                choice.label,
                () => {
                    if (choice.validate && !choice.validate()) return;
                    finishModal(
                        typeof choice.value === "function"
                            ? choice.value()
                            : choice.value,
                    );
                },
                choice.className || "",
            );
            if (choice.submit) node.type = "submit";
            $("modal-actions").append(node);
        }
        $("modal-form").onsubmit = (event) => {
            event.preventDefault();
            const submit = choices.find((choice) => choice.submit);
            if (submit && (!submit.validate || submit.validate()))
                finishModal(
                    typeof submit.value === "function"
                        ? submit.value()
                        : submit.value,
                );
        };
        const result = new Promise((resolve) => {
            state.modalResolve = resolve;
        });
        $("modal").showModal();
        if (focusInput) {
            focusInput.focus();
            focusInput.select();
        }
        return result;
    }
    function finishModal(value) {
        const resolve = state.modalResolve;
        state.modalResolve = null;
        if ($("modal").open) $("modal").close();
        if (resolve) resolve(value);
    }
    $("modal-close").onclick = () => finishModal(null);
    $("modal").addEventListener("cancel", (event) => {
        event.preventDefault();
        finishModal(null);
    });
    $("modal").addEventListener("close", () => {
        if (state.modalResolve) finishModal(null);
    });
    $("notice-close").onclick = () => {
        $("notice").hidden = true;
    };

    function renderSidebar() {
        for (const [id, entries, iconName] of [
            ["shortcuts", state.shortcuts, "folder"],
            ["side-drives", state.drives, "drive"],
        ]) {
            $(id).replaceChildren();
            for (const entry of entries) {
                const node = button(
                    "",
                    () => navigate(entry.path),
                    "side-item",
                );
                node.append(icon(iconName), element("span", "", entry.name));
                node.dataset.path = entry.path;
                node.title = entry.path;
                if (entry.accessible === false) {
                    node.disabled = true;
                    node.title += " (Unavailable)";
                }
                $(id).append(node);
            }
        }
        markSidebar();
    }
    function markSidebar() {
        document.querySelectorAll(".side-item").forEach((node) => {
            const active =
                node.dataset.action === "home"
                    ? state.path === null
                    : node.dataset.action === "recycle-bin"
                      ? inRecycleBin()
                      : node.dataset.path === state.path;
            node.classList.toggle("active", active);
            if (active) node.setAttribute("aria-current", "page");
            else node.removeAttribute("aria-current");
        });
    }
    function renderBreadcrumbs() {
        $("breadcrumbs").replaceChildren(
            button("This PC", () => navigate(null)),
        );
        const crumbs = state.breadcrumbs.length
            ? state.breadcrumbs
            : state.path
              ? [{ name: basename(state.path), path: state.path }]
              : [];
        for (const crumb of crumbs) {
            if (!crumb.path || /^c:\\?$/i.test(crumb.path)) continue;
            const node = button(crumb.name, () => navigate(crumb.path));
            node.title = crumb.path;
            $("breadcrumbs").append(icon("chevron", true), node);
        }
        $("breadcrumbs").scrollLeft = $("breadcrumbs").scrollWidth;
        $("address-input").value = inRecycleBin()
            ? "Recycle Bin"
            : state.path || "This PC";
        $("address")
            .querySelector(".address-icon use")
            .setAttribute(
                "href",
                inRecycleBin()
                    ? "#i-trash"
                    : state.path
                      ? "#i-folder"
                      : "#i-pc",
            );
    }
    function updateChrome() {
        const title = inRecycleBin()
            ? "Recycle Bin"
            : state.query
              ? `Search: ${state.query}`
              : state.path
                ? basename(state.path)
                : "This PC";
        $("folder-title").textContent = title;
        $("tab-title").textContent = title;
        document.title = `${title} - File Explorer`;
        $("folder-subtitle").textContent = inRecycleBin()
            ? "Restore items to their original locations. Deleting and emptying are disabled."
            : state.path
              ? state.path
              : "Devices and drives";
        $("search-input").placeholder = inRecycleBin()
            ? "Restore-only Recycle Bin"
            : state.path
              ? `Search ${basename(state.path)}`
              : "Open a folder to search";
        $("search-input").disabled = state.path === null || inRecycleBin();
        $("search-form").querySelector("button").disabled =
            state.path === null || inRecycleBin();
        document.querySelector('[data-sort="modified"]').textContent =
            inRecycleBin() ? "Date deleted" : "Date modified";
        $("search-input").value = state.query;
        renderBreadcrumbs();
        markSidebar();
        updateCommands();
    }
    async function navigate(path, query = "", mode = "push") {
        closeMenu();
        $("sidebar").classList.remove("open");
        document
            .querySelector('[data-action="sidebar"]')
            .setAttribute("aria-expanded", "false");
        stopAddress();
        if (state.controller) state.controller.abort();
        const controller = new AbortController();
        const requestId = ++state.request;
        state.controller = controller;
        state.path = path;
        state.parent = null;
        state.breadcrumbs = [];
        state.query = path === null || path === RECYCLE_BIN ? "" : query;
        state.items = [];
        state.ordered = [];
        state.errors = [];
        state.selected.clear();
        state.focus = state.anchor = null;
        state.loading = true;
        if (mode === "push") {
            const previous = state.history[state.historyIndex];
            if (
                !previous ||
                previous.path !== path ||
                previous.query !== state.query
            ) {
                state.history = state.history.slice(0, state.historyIndex + 1);
                state.history.push({ path, query: state.query });
                state.historyIndex = state.history.length - 1;
            }
        }
        updateChrome();
        $("home-view").hidden = true;
        $("column-header").hidden = true;
        $("file-list").hidden = true;
        $("search-summary").hidden = true;
        emptyState("Loading...", "", true);
        updateStatus();
        const done = busy(state.query ? "Searching..." : "Loading...");
        try {
            if (path === null) {
                const data = await api("/api/drives", {
                    signal: controller.signal,
                });
                if (requestId !== state.request) return;
                state.drives = data.drives || [];
                state.shortcuts = data.shortcuts || [];
                renderSidebar();
                renderHome();
            } else {
                const route = inRecycleBin()
                    ? "/api/recycle-bin"
                    : state.query
                      ? "/api/search"
                      : "/api/list";
                const data = await api(
                    inRecycleBin()
                        ? route
                        : url(route, {
                              path,
                              q: state.query || undefined,
                              hidden: state.hidden ? 1 : 0,
                          }),
                    { signal: controller.signal },
                );
                if (requestId !== state.request) return;
                state.path = data.path;
                state.parent = data.parent;
                state.breadcrumbs = data.breadcrumbs || [];
                state.items = data.items || [];
                state.errors = data.errors || [];
                state.truncated = data.truncated === true;
                state.scanned = data.scanned || 0;
                const current = state.history[state.historyIndex];
                if (current) current.path = data.path;
                renderFiles();
                renderSearchSummary();
                if (inRecycleBin() && state.errors.length)
                    notify(
                        "Some Recycle Bin items could not be read.",
                        true,
                        state.errors,
                    );
            }
        } catch (error) {
            if (requestId !== state.request || error.name === "AbortError")
                return;
            emptyState("Cannot open this location", error.message);
            $("empty-state").append(button("Try again", refresh));
            notify(error.message, true);
        } finally {
            done();
            if (requestId === state.request) {
                state.loading = false;
                updateChrome();
                updateStatus();
                updateBusy();
            }
        }
    }
    function refresh() {
        return navigate(state.path, state.query, "refresh");
    }
    function historyMove(delta) {
        const index = state.historyIndex + delta;
        if (index < 0 || index >= state.history.length) return;
        state.historyIndex = index;
        const entry = state.history[index];
        navigate(entry.path, entry.query, "history");
    }
    function emptyState(title, description = "", loading = false) {
        const node = $("empty-state");
        node.hidden = false;
        node.replaceChildren(
            loading ? element("span", "spinner") : icon("folder"),
            element("strong", "", title),
        );
        if (description) node.append(element("p", "", description));
    }
    function renderHome() {
        const home = $("home-view");
        home.replaceChildren();
        $("empty-state").hidden = true;
        home.hidden = false;
        if (state.shortcuts.length) {
            home.append(element("h2", "section-title", "Quick access"));
            const shortcuts = element("div", "quick-grid");
            state.shortcuts.forEach((entry) => {
                const node = button(
                    "",
                    () => navigate(entry.path),
                    "quick-card",
                );
                node.append(icon("folder"), element("span", "", entry.name));
                node.title = entry.path;
                shortcuts.append(node);
            });
            home.append(shortcuts);
        }
        home.append(
            element(
                "h2",
                "section-title",
                `Devices and drives (${state.drives.length})`,
            ),
        );
        const drives = element("div", "drive-grid");
        for (const drive of state.drives) {
            const node = button("", () => navigate(drive.path), "drive-card");
            const body = element("div", "drive-body");
            const letter = String(drive.letter || "").replace(/[:\\/]/g, "");
            const name = drive.name
                .toLowerCase()
                .includes(`${letter.toLowerCase()}:`)
                ? drive.name
                : `${drive.name} (${letter}:)`;
            body.append(element("div", "drive-name", name));
            const isC = letter.toLowerCase() === "c";
            body.append(
                element(
                    "div",
                    "drive-scope",
                    isC ? "C:\\Users only" : drive.kind || drive.path,
                ),
            );
            if (drive.accessible === false) {
                node.disabled = true;
                body.append(
                    element("div", "capacity-text", "Drive unavailable"),
                );
            } else if (
                drive.total !== null &&
                drive.free !== null &&
                Number(drive.total) > 0
            ) {
                const percent = Math.max(
                    0,
                    Math.min(100, 100 * (1 - drive.free / drive.total)),
                );
                const meter = element("div", "capacity");
                const fill = element("span", "capacity-fill");
                fill.style.width = `${percent}%`;
                meter.append(fill);
                meter.setAttribute("role", "meter");
                meter.setAttribute("aria-label", `${name} space used`);
                meter.setAttribute("aria-valuemin", "0");
                meter.setAttribute("aria-valuemax", "100");
                meter.setAttribute(
                    "aria-valuenow",
                    String(Math.round(percent)),
                );
                meter.setAttribute(
                    "aria-valuetext",
                    `${bytes(drive.free)} free of ${bytes(drive.total)}`,
                );
                meter.title = `${percent.toFixed(1)}% used`;
                body.append(
                    meter,
                    element(
                        "div",
                        "capacity-text",
                        `${bytes(drive.free)} free of ${bytes(drive.total)}`,
                    ),
                );
            } else
                body.append(
                    element("div", "capacity-text", "Capacity unavailable"),
                );
            node.append(icon("drive"), body);
            node.title = `${drive.path}${isC ? "\nCapacity is for the whole drive. Access is limited to Users." : ""}`;
            drives.append(node);
        }
        home.append(
            drives,
            element(
                "p",
                "home-hint",
                "C: is limited to C:\\Users. Drive capacity refers to the whole drive.",
            ),
        );
    }
    function renderSearchSummary() {
        const node = $("search-summary");
        node.hidden = !state.query;
        if (!state.query) return;
        let summary = `${state.items.length.toLocaleString()} results · ${state.scanned.toLocaleString()} entries scanned`;
        if (state.truncated) summary += " · Results limited";
        if (state.errors.length)
            summary += ` · ${state.errors.length.toLocaleString()} skipped`;
        node.replaceChildren(
            element("span", "", summary),
            button("Clear search", () => navigate(state.path)),
        );
        if (state.errors.length)
            node.append(
                button("Skipped details", () => showErrors(state.errors)),
            );
    }
    function sortItems() {
        const direction = state.direction === "asc" ? 1 : -1;
        state.ordered = [...state.items].sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            let comparison = 0;
            if (state.sort === "name" || state.sort === "type")
                comparison = collator.compare(
                    a[state.sort] || "",
                    b[state.sort] || "",
                );
            else {
                const av = a[state.sort],
                    bv = b[state.sort];
                if (av === null || av === undefined)
                    comparison = bv === null || bv === undefined ? 0 : 1;
                else if (bv === null || bv === undefined) comparison = -1;
                else comparison = av - bv;
            }
            return (
                comparison * direction ||
                collator.compare(a.name, b.name) ||
                collator.compare(a.path, b.path)
            );
        });
    }
    function renderFiles() {
        sortItems();
        $("home-view").hidden = true;
        $("file-list").className = `file-list ${state.view}`;
        $("column-header").hidden = state.view !== "details";
        $("file-list").hidden = state.items.length === 0;
        $("empty-state").hidden = state.items.length > 0;
        if (!state.items.length)
            emptyState(
                inRecycleBin()
                    ? "Recycle Bin is empty"
                    : state.query
                      ? "No results"
                      : "This folder is empty",
                inRecycleBin()
                    ? "Only items from accessible locations are shown."
                    : state.query
                      ? "Try another name or clear the search."
                      : "Create an item or drop files here to upload.",
            );
        const fragment = document.createDocumentFragment();
        state.ordered.forEach((item, index) => {
            const row = element("div", "file-row");
            row.dataset.index = String(index);
            row.setAttribute("role", "option");
            row.setAttribute(
                "aria-selected",
                String(state.selected.has(item.path)),
            );
            row.classList.toggle("hidden-item", item.hidden === true);
            row.classList.toggle("blocked", item.accessible === false);
            row.title = item.error
                ? `${item.path}\n${item.error}`
                : item.original_path || item.path;
            const name = element("div", "file-cell name");
            const label = element("div", "name-text");
            label.append(element("span", "name-main", item.name));
            if (state.query || inRecycleBin())
                label.append(element("span", "name-location", item.parent));
            name.append(icon(kindIcon(item)), label);
            if (item.is_link) name.append(element("span", "link-mark", "Link"));
            if (item.accessible === false) name.append(icon("lock", true));
            row.append(
                name,
                element("div", "file-cell modified", date(item.modified)),
                element(
                    "div",
                    "file-cell type",
                    item.type || (item.is_dir ? "File folder" : "File"),
                ),
                element(
                    "div",
                    "file-cell size",
                    item.is_dir ? "" : bytes(item.size),
                ),
            );
            fragment.append(row);
        });
        $("file-list").replaceChildren(fragment);
        document.querySelectorAll("[data-sort]").forEach((node) => {
            node.classList.toggle("sorted", node.dataset.sort === state.sort);
            node.classList.toggle("desc", state.direction === "desc");
            node.setAttribute(
                "aria-label",
                `Sort by ${node.textContent}, ${node.dataset.sort === state.sort ? (state.direction === "asc" ? "ascending" : "descending") : "not selected"}`,
            );
        });
        updateSelection();
    }
    function updateSelection() {
        $("file-list")
            .querySelectorAll(".file-row")
            .forEach((row) => {
                const item = state.ordered[Number(row.dataset.index)];
                row.classList.toggle("selected", state.selected.has(item.path));
                row.classList.toggle("focused", state.focus === item.path);
                row.classList.toggle(
                    "cut",
                    state.clipboard?.mode === "move" &&
                        state.clipboard.paths.includes(item.path),
                );
                row.setAttribute(
                    "aria-selected",
                    String(state.selected.has(item.path)),
                );
            });
        updateCommands();
        updateStatus();
    }
    function updateStatus() {
        $("item-count").textContent = state.loading
            ? "Loading..."
            : state.path === null
              ? `${state.drives.length} drives`
              : `${state.items.length.toLocaleString()} ${state.items.length === 1 ? "item" : "items"}`;
        const selected = selectedItems();
        let summary = selected.length ? `${selected.length} selected` : "";
        if (
            selected.length &&
            selected.every((item) => !item.is_dir && item.size !== null)
        )
            summary += ` · ${bytes(selected.reduce((sum, item) => sum + item.size, 0))}`;
        $("selection-status").textContent = summary;
        $("clipboard-status").textContent = state.clipboard
            ? `${state.clipboard.paths.length} ${state.clipboard.mode === "move" ? "cut" : "copied"}`
            : "";
    }
    function available(action) {
        const selected = selectedItems();
        const ready = !state.loading && !state.working;
        const folder = state.path !== null && !inRecycleBin();
        if (
            inRecycleBin() &&
            [
                "cut",
                "copy",
                "paste",
                "rename",
                "delete",
                "download",
                "preview",
                "properties",
                "new-folder",
                "new-file",
                "upload-files",
                "upload-folder",
                "hidden",
            ].includes(action)
        )
            return false;
        switch (action) {
            case "restore":
                return ready && inRecycleBin() && selected.length > 0;
            case "back":
                return state.historyIndex > 0;
            case "forward":
                return state.historyIndex < state.history.length - 1;
            case "up":
                return state.path !== null && !state.loading;
            case "paste":
                return ready && folder && !!state.clipboard;
            case "new-folder":
            case "new-file":
            case "upload-files":
            case "upload-folder":
                return ready && folder;
            case "rename":
                return (
                    ready &&
                    selected.length === 1 &&
                    selected[0].accessible !== false
                );
            case "cut":
            case "copy":
            case "delete":
            case "download":
                return (
                    ready &&
                    selected.length > 0 &&
                    selected.every((item) => item.accessible !== false)
                );
            case "properties":
                return (
                    ready &&
                    (selected.length === 1 || (selected.length === 0 && folder))
                );
            default:
                return true;
        }
    }
    function updateCommands() {
        $("restore-button").hidden = !inRecycleBin();
        document
            .querySelectorAll(
                '.commandbar [data-action], .commandbar [data-menu="new"], .commandbar [data-menu="upload"]',
            )
            .forEach((node) => {
                if (node.id !== "restore-button") node.hidden = inRecycleBin();
            });
        document.querySelectorAll("[data-action]").forEach((node) => {
            node.disabled = !available(node.dataset.action);
        });
        document.querySelector('[data-menu="new"]').disabled =
            !available("new-folder");
        document.querySelector('[data-menu="upload"]').disabled =
            !available("upload-files");
        document.querySelectorAll(".view-buttons button").forEach((node) => {
            const active = node.dataset.action === state.view;
            node.classList.toggle("active", active);
            node.setAttribute("aria-pressed", String(active));
        });
    }
    function setView(view) {
        state.view = view;
        savePreferences();
        if (state.path !== null && !state.loading) renderFiles();
        updateCommands();
    }
    function setSort(sort) {
        if (state.sort === sort)
            state.direction = state.direction === "asc" ? "desc" : "asc";
        else {
            state.sort = sort;
            state.direction = "asc";
        }
        savePreferences();
        if (state.path !== null && !state.loading) renderFiles();
    }
    function selectItem(index, control, shift) {
        const item = state.ordered[index];
        if (!item) return;
        if (shift) {
            let anchor = state.ordered.findIndex(
                (entry) => entry.path === state.anchor,
            );
            if (anchor < 0) anchor = index;
            if (!control) state.selected.clear();
            for (
                let i = Math.min(anchor, index);
                i <= Math.max(anchor, index);
                i++
            )
                state.selected.add(state.ordered[i].path);
        } else if (control) {
            if (state.selected.has(item.path)) state.selected.delete(item.path);
            else state.selected.add(item.path);
            state.anchor = item.path;
        } else {
            state.selected.clear();
            state.selected.add(item.path);
            state.anchor = item.path;
        }
        state.focus = item.path;
        updateSelection();
    }
    $("file-list").addEventListener("click", (event) => {
        const row = event.target.closest(".file-row");
        if (!row) {
            state.selected.clear();
            state.focus = state.anchor = null;
            updateSelection();
            return;
        }
        selectItem(
            Number(row.dataset.index),
            event.ctrlKey || event.metaKey,
            event.shiftKey,
        );
        $("file-list").focus({ preventScroll: true });
    });
    $("file-list").addEventListener("dblclick", (event) => {
        const row = event.target.closest(".file-row");
        if (row) openItem(state.ordered[Number(row.dataset.index)]);
    });
    function openItem(item) {
        if (inRecycleBin()) {
            restoreItems();
            return;
        }
        if (item.accessible === false) {
            notify(
                item.error ||
                    "This item is inaccessible or points outside the allowed locations.",
                true,
            );
            return;
        }
        if (item.is_dir) navigate(item.path);
        else openPreview(item);
    }
    function startAddress() {
        $("breadcrumbs").hidden = true;
        $("address-form").hidden = false;
        $("address-input").value = inRecycleBin()
            ? "Recycle Bin"
            : state.path || "This PC";
        $("address-input").focus();
        $("address-input").select();
    }
    function stopAddress() {
        $("address-form").hidden = true;
        $("breadcrumbs").hidden = false;
    }
    $("address").addEventListener("click", (event) => {
        if (
            event.target === $("address") ||
            event.target.classList.contains("address-icon")
        )
            startAddress();
    });
    $("address-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const path = $("address-input").value.trim();
        if (!path || /^this pc$/i.test(path)) navigate(null);
        else if (/^recycle[ -]bin$/i.test(path)) navigate(RECYCLE_BIN);
        else navigate(path);
    });
    $("address-input").addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            stopAddress();
            $("file-list").focus();
        }
    });
    $("address-input").addEventListener("blur", stopAddress);
    $("search-form").addEventListener("submit", (event) => {
        event.preventDefault();
        if (state.path !== null)
            navigate(state.path, $("search-input").value.trim());
    });
    $("search-input").addEventListener("input", () => {
        if (!$("search-input").value && state.query) navigate(state.path);
    });

    function closeMenu() {
        $("context-menu").hidden = true;
    }
    function menuEntry(label, action, iconName, key = "", chosen = false) {
        return { label, action, iconName, key, chosen };
    }
    function showMenu(entries, x, y) {
        const menu = $("context-menu");
        menu.replaceChildren();
        entries.forEach((entry) => {
            if (!entry) {
                menu.append(element("hr"));
                return;
            }
            const node = button("", () => {
                closeMenu();
                dispatch(entry.action);
            });
            node.setAttribute("role", "menuitem");
            if (entry.iconName) node.append(icon(entry.iconName));
            node.append(element("span", "menu-label", entry.label));
            if (entry.key) node.append(element("span", "menu-key", entry.key));
            node.classList.toggle("chosen", !!entry.chosen);
            node.disabled = !available(entry.action);
            menu.append(node);
        });
        menu.hidden = false;
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(12, Math.min(x, window.innerWidth - rect.width - 12))}px`;
        menu.style.top = `${Math.max(12, Math.min(y, window.innerHeight - rect.height - 12))}px`;
        menu.querySelector("button:not(:disabled)")?.focus({
            preventScroll: true,
        });
    }
    function toolbarMenu(name, node) {
        const entries = {
            new: [
                menuEntry("New folder", "new-folder", "folder", "Ctrl+Shift+N"),
                menuEntry("New file", "new-file", "file"),
            ],
            upload: [
                menuEntry("Upload files", "upload-files", "upload"),
                menuEntry("Upload folder", "upload-folder", "folder"),
            ],
            sort: [
                menuEntry(
                    "Name",
                    "sort-name",
                    "sort",
                    "",
                    state.sort === "name",
                ),
                menuEntry(
                    inRecycleBin() ? "Date deleted" : "Date modified",
                    "sort-modified",
                    "sort",
                    "",
                    state.sort === "modified",
                ),
                menuEntry(
                    "Type",
                    "sort-type",
                    "sort",
                    "",
                    state.sort === "type",
                ),
                menuEntry(
                    "Size",
                    "sort-size",
                    "sort",
                    "",
                    state.sort === "size",
                ),
                null,
                menuEntry(
                    "Ascending",
                    "sort-asc",
                    "up",
                    "",
                    state.direction === "asc",
                ),
                menuEntry(
                    "Descending",
                    "sort-desc",
                    "down",
                    "",
                    state.direction === "desc",
                ),
            ],
            view: [
                menuEntry(
                    "Details",
                    "details",
                    "list",
                    "",
                    state.view === "details",
                ),
                menuEntry(
                    "Large icons",
                    "grid",
                    "grid",
                    "",
                    state.view === "grid",
                ),
                null,
                menuEntry(
                    "Show hidden items",
                    "hidden",
                    "eye",
                    "",
                    state.hidden,
                ),
            ],
            more: inRecycleBin()
                ? [
                      menuEntry("Restore", "restore", "refresh"),
                      menuEntry("Select all", "select-all", "list", "Ctrl+A"),
                      menuEntry("Refresh", "refresh", "refresh", "F5"),
                  ]
                : [
                      menuEntry(
                          "Properties",
                          "properties",
                          "info",
                          "Alt+Enter",
                      ),
                      null,
                      menuEntry("Select all", "select-all", "list", "Ctrl+A"),
                      menuEntry("Keyboard shortcuts", "shortcuts", "info"),
                  ],
        };
        const rect = node.getBoundingClientRect();
        showMenu(entries[name], rect.left, rect.bottom + 4);
    }
    $("main").addEventListener("contextmenu", (event) => {
        if (state.path === null || state.loading) return;
        event.preventDefault();
        const row = event.target.closest(".file-row");
        if (row) {
            const index = Number(row.dataset.index);
            if (!state.selected.has(state.ordered[index].path))
                selectItem(index, false, false);
            state.focus = state.ordered[index].path;
        } else {
            state.selected.clear();
            updateSelection();
        }
        const selected = selectedItems();
        if (inRecycleBin()) {
            showMenu(
                [
                    menuEntry("Restore", "restore", "refresh", "Enter"),
                    menuEntry("Select all", "select-all", "list", "Ctrl+A"),
                    menuEntry("Refresh", "refresh", "refresh", "F5"),
                ],
                event.clientX,
                event.clientY,
            );
            return;
        }
        const entries = selected.length
            ? [
                  menuEntry(
                      selected.length === 1 && selected[0].is_dir
                          ? "Open folder"
                          : "Preview",
                      "preview",
                      "folder",
                      "Enter",
                  ),
                  menuEntry("Cut", "cut", "cut", "Ctrl+X"),
                  menuEntry("Copy", "copy", "copy", "Ctrl+C"),
                  menuEntry("Rename", "rename", "rename", "F2"),
                  menuEntry("Download", "download", "download"),
                  menuEntry("Delete", "delete", "trash", "Delete"),
                  null,
                  menuEntry("Properties", "properties", "info", "Alt+Enter"),
              ]
            : [
                  menuEntry("New folder", "new-folder", "folder"),
                  menuEntry("New file", "new-file", "file"),
                  menuEntry("Paste", "paste", "paste", "Ctrl+V"),
                  menuEntry("Upload files", "upload-files", "upload"),
                  menuEntry("Upload folder", "upload-folder", "folder"),
                  null,
                  menuEntry("Refresh", "refresh", "refresh", "F5"),
                  menuEntry("Properties", "properties", "info"),
              ];
        showMenu(entries, event.clientX, event.clientY);
    });
    document.addEventListener("pointerdown", (event) => {
        if (
            !event.target.closest("#context-menu") &&
            !event.target.closest("[data-menu]")
        )
            closeMenu();
    });
    window.addEventListener("resize", closeMenu);
    $("context-menu").addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            closeMenu();
            $("file-list").focus();
            return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
        event.preventDefault();
        const items = [
            ...$("context-menu").querySelectorAll("button:not(:disabled)"),
        ];
        let index = items.indexOf(document.activeElement);
        if (event.key === "Home") index = 0;
        else if (event.key === "End") index = items.length - 1;
        else
            index =
                (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                items.length;
        items[index]?.focus();
    });
    document.addEventListener("click", (event) => {
        const command = event.target.closest("[data-action]");
        if (command && !command.disabled) {
            dispatch(command.dataset.action);
            return;
        }
        const menu = event.target.closest("[data-menu]");
        if (menu && !menu.disabled) toolbarMenu(menu.dataset.menu, menu);
        const sort = event.target.closest("[data-sort]");
        if (sort) setSort(sort.dataset.sort);
    });

    async function mutate(label, operation) {
        if (state.working) return;
        state.working = true;
        updateCommands();
        const done = busy(label);
        try {
            return await operation();
        } catch (error) {
            reportError(error);
        } finally {
            state.working = false;
            done();
            updateCommands();
        }
    }
    function snapshot() {
        return { path: state.path, query: state.query };
    }
    async function refreshSnapshot(location) {
        if (state.path === location.path && state.query === location.query)
            await refresh();
    }
    async function createItem(kind) {
        if (!available(`new-${kind}`)) return;
        const location = snapshot();
        const content = element("div");
        const label = element("label", "", "Name");
        label.htmlFor = "name-input";
        const input = element("input");
        input.type = "text";
        input.id = "name-input";
        input.required = true;
        input.autocomplete = "off";
        input.value = kind === "folder" ? "New folder" : "New file.txt";
        content.append(label, input);
        const name = await showModal(
            kind === "folder" ? "New folder" : "New file",
            content,
            [
                { label: "Cancel", value: null },
                {
                    label: "Create",
                    value: () => input.value,
                    className: "primary",
                    submit: true,
                    validate: () => input.reportValidity(),
                },
            ],
            input,
        );
        if (name === null) return;
        await mutate("Creating...", async () => {
            await post("/api/create", { path: location.path, name, kind });
            notify(`${kind === "folder" ? "Folder" : "File"} created.`);
            await refreshSnapshot(location);
        });
    }
    async function renameItem() {
        if (!available("rename")) return;
        const item = selectedItems()[0];
        const location = snapshot();
        const content = element("div");
        const label = element("label", "", "New name");
        label.htmlFor = "rename-input";
        const input = element("input");
        input.type = "text";
        input.id = "rename-input";
        input.required = true;
        input.value = item.name;
        input.autocomplete = "off";
        content.append(label, input);
        const name = await showModal(
            "Rename",
            content,
            [
                { label: "Cancel", value: null },
                {
                    label: "Rename",
                    value: () => input.value,
                    className: "primary",
                    submit: true,
                    validate: () => input.reportValidity(),
                },
            ],
            input,
        );
        if (name === null || name === item.name) return;
        await mutate("Renaming...", async () => {
            const data = await post("/api/rename", { path: item.path, name });
            if (state.clipboard)
                state.clipboard.paths = state.clipboard.paths.map((path) =>
                    path === item.path ? data.item.path : path,
                );
            notify("Item renamed.");
            await refreshSnapshot(location);
        });
    }
    async function deleteItems() {
        if (!available("delete")) return;
        const items = selectedItems();
        const location = snapshot();
        const content = element("div");
        content.append(
            element(
                "p",
                "",
                items.length === 1
                    ? `Move “${items[0].name}” to the Recycle Bin?`
                    : `Move ${items.length} selected items to the Recycle Bin?`,
            ),
        );
        content.append(
            element(
                "p",
                "",
                "You can restore these items from the Recycle Bin. Permanent deletion is disabled.",
            ),
        );
        const confirmed = await showModal("Move to Recycle Bin", content, [
            { label: "Cancel", value: false },
            {
                label: "Move to Recycle Bin",
                value: true,
                className: "primary",
                submit: true,
            },
        ]);
        if (!confirmed) return;
        await mutate("Recycling...", async () => {
            const data = await post("/api/delete", {
                paths: items.map((item) => item.path),
            });
            const completed = data.completed || [];
            if (state.clipboard) {
                state.clipboard.paths = state.clipboard.paths.filter(
                    (path) => !completed.includes(path),
                );
                if (!state.clipboard.paths.length) state.clipboard = null;
            }
            reportBatch(data, "moved to the Recycle Bin");
            await refreshSnapshot(location);
        });
    }
    async function restoreItems() {
        if (!available("restore")) return;
        const items = selectedItems();
        const location = snapshot();
        const content = element(
            "p",
            "",
            items.length === 1
                ? `Restore “${items[0].name}” to ${items[0].parent}?`
                : `Restore ${items.length} items to their original locations?`,
        );
        const confirmed = await showModal("Restore items", content, [
            { label: "Cancel", value: false },
            {
                label: "Restore",
                value: true,
                className: "primary",
                submit: true,
            },
        ]);
        if (!confirmed) return;
        await mutate("Restoring...", async () => {
            const data = await post("/api/recycle-bin/restore", {
                ids: items.map((item) => item.path),
            });
            reportBatch(data, "restored");
            await refreshSnapshot(location);
        });
    }
    function copyItems(mode) {
        if (!available(mode === "move" ? "cut" : "copy")) return;
        state.clipboard = {
            paths: selectedItems().map((item) => item.path),
            mode,
        };
        updateSelection();
    }
    async function conflictRequest(request) {
        let conflict = "error";
        for (;;) {
            try {
                return await request(conflict);
            } catch (error) {
                if (error.status !== 409 || !Array.isArray(error.conflicts))
                    throw error;
                const content = element("div");
                content.append(
                    element(
                        "p",
                        "",
                        error.message ||
                            "Items with the same name already exist.",
                    ),
                );
                if (error.conflicts.length) {
                    const list = element("ul");
                    error.conflicts.slice(0, 8).forEach((entry) => {
                        const text =
                            typeof entry === "string"
                                ? entry
                                : entry.destination ||
                                  entry.path ||
                                  entry.name ||
                                  entry.source ||
                                  "Existing item";
                        list.append(element("li", "", text));
                    });
                    if (error.conflicts.length > 8)
                        list.append(
                            element(
                                "li",
                                "",
                                `${error.conflicts.length - 8} more conflicts`,
                            ),
                        );
                    content.append(list);
                }
                content.append(
                    element(
                        "p",
                        "",
                        "Replace overwrites existing files. Keep both uses unique names.",
                    ),
                );
                conflict = await showModal("Name conflict", content, [
                    { label: "Cancel", value: null },
                    { label: "Keep both", value: "keep_both" },
                    {
                        label: "Replace existing",
                        value: "replace",
                        className: "primary",
                    },
                ]);
                if (!conflict) return null;
            }
        }
    }
    function reportBatch(data, verb) {
        const completed = data.completed || [];
        const errors = data.errors || [];
        const success = completed.length
            ? `${completed.length} ${completed.length === 1 ? "item" : "items"} ${verb}.`
            : "No items completed.";
        notify(
            `${success}${errors.length ? ` ${errors.length} failed.` : ""}`,
            errors.length > 0,
            errors,
        );
    }
    async function pasteItems() {
        if (!available("paste")) return;
        const location = snapshot();
        const clipboard = state.clipboard;
        await mutate(
            clipboard.mode === "move" ? "Moving..." : "Copying...",
            async () => {
                const data = await conflictRequest((conflict) =>
                    post("/api/transfer", {
                        paths: clipboard.paths,
                        destination: location.path,
                        mode: clipboard.mode,
                        conflict,
                    }),
                );
                if (!data) return;
                if (
                    clipboard.mode === "move" &&
                    state.clipboard === clipboard
                ) {
                    const sources = new Set(
                        (data.completed || []).map((item) => item.source),
                    );
                    clipboard.paths = clipboard.paths.filter(
                        (path) => !sources.has(path),
                    );
                    if (!clipboard.paths.length) state.clipboard = null;
                }
                reportBatch(
                    data,
                    clipboard.mode === "move" ? "moved" : "copied",
                );
                await refreshSnapshot(location);
                updateSelection();
            },
        );
    }
    async function upload(files) {
        if (!files.length || !available("upload-files")) return;
        const location = snapshot();
        await mutate(
            `Uploading ${files.length} ${files.length === 1 ? "file" : "files"}...`,
            async () => {
                const data = await conflictRequest((conflict) => {
                    const form = new FormData();
                    form.append("path", location.path);
                    form.append("conflict", conflict);
                    files.forEach((file) =>
                        form.append(
                            "files",
                            file,
                            file.webkitRelativePath || file.name,
                        ),
                    );
                    return api("/api/upload", { method: "POST", body: form });
                });
                if (!data) return;
                reportBatch(data, "uploaded");
                await refreshSnapshot(location);
            },
        );
    }
    for (const id of ["upload-files", "upload-folder"]) {
        $(id).addEventListener("change", () => {
            const files = [...$(id).files];
            $(id).value = "";
            upload(files);
        });
    }
    let dragDepth = 0;
    function hasFiles(event) {
        return [...(event.dataTransfer?.types || [])].includes("Files");
    }
    document.addEventListener("dragenter", (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth++;
        if (
            available("upload-files") &&
            !$("modal").open &&
            !$("preview").open
        ) {
            $("drop-destination").textContent = state.path;
            $("drop-overlay").hidden = false;
        }
    });
    document.addEventListener("dragover", (event) => {
        if (hasFiles(event)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = available("upload-files")
                ? "copy"
                : "none";
        }
    });
    document.addEventListener("dragleave", (event) => {
        if (hasFiles(event)) {
            dragDepth = Math.max(0, dragDepth - 1);
            if (!dragDepth) $("drop-overlay").hidden = true;
        }
    });
    document.addEventListener("drop", (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth = 0;
        $("drop-overlay").hidden = true;
        if ($("modal").open || $("preview").open) return;
        if (!available("upload-files")) {
            notify("Open a folder before uploading files.", true);
            return;
        }
        const entries = [...(event.dataTransfer.items || [])];
        if (entries.some((entry) => entry.webkitGetAsEntry?.()?.isDirectory)) {
            notify(
                "Use Upload folder to preserve folders and their contents.",
                true,
            );
            return;
        }
        upload([...event.dataTransfer.files]);
    });
    function downloadItems(items) {
        if (!items.length) return;
        if (items.length === 1) {
            const link = element("a");
            link.href = url("/download", { path: items[0].path });
            link.download = "";
            document.body.append(link);
            link.click();
            link.remove();
        } else {
            const form = element("form");
            form.method = "POST";
            form.action = "/download";
            form.hidden = true;
            for (const [name, value] of [
                ["paths", JSON.stringify(items.map((item) => item.path))],
                ["csrf_token", token],
            ]) {
                const input = element("input");
                input.type = "hidden";
                input.name = name;
                input.value = value;
                form.append(input);
            }
            document.body.append(form);
            form.submit();
            form.remove();
        }
        if (items.length > 1 || items[0].is_dir)
            notify(
                "Archive download requested. Skipped files are listed in its error report.",
            );
    }
    async function properties() {
        if (!available("properties")) return;
        const item = selectedItems()[0];
        const path = item ? item.path : state.path;
        const done = busy("Reading properties...");
        try {
            const data = await api(url("/api/properties", { path }));
            const list = element("dl", "property-list");
            const values = [
                ["Name", data.name],
                ["Location", data.path],
                ["Type", data.type],
                [
                    "Size",
                    data.is_dir
                        ? "Not calculated for folders"
                        : bytes(data.size),
                ],
                ["Created", date(data.created)],
                ["Modified", date(data.modified)],
                [
                    "Attributes",
                    [
                        data.hidden && "Hidden",
                        data.readonly && "Read-only",
                        data.is_link && "Link",
                        data.protected && "Protected",
                    ]
                        .filter(Boolean)
                        .join(", ") || "None",
                ],
                [
                    "Access",
                    data.accessible === false
                        ? data.error || "Unavailable"
                        : "Accessible",
                ],
            ];
            values.forEach(([label, value]) =>
                list.append(
                    element("dt", "", label),
                    element("dd", "", value || "Unknown"),
                ),
            );
            await showModal("Properties", list, [
                { label: "Close", value: false },
            ]);
        } catch (error) {
            reportError(error);
        } finally {
            done();
        }
    }
    async function openPreview(item) {
        if (state.preview?.dirty && !(await discardEditor())) return;
        const id = ++state.previewId;
        state.preview = {
            item,
            text: null,
            encoding: null,
            editable: false,
            editing: false,
            dirty: false,
            saving: false,
        };
        $("preview-title").textContent = item.name;
        $("preview-caption").textContent =
            `${item.type || "File"} · ${bytes(item.size)}`;
        $("edit-button").hidden = true;
        $("save-button").hidden = true;
        $("preview-body").replaceChildren(element("span", "spinner"));
        if (!$("preview").open) $("preview").showModal();
        const ext = extension(item);
        const src = url("/file", { path: item.path });
        const showFailure = () => {
            if (id === state.previewId)
                previewMessage(
                    "Preview unavailable",
                    "Download this file to view it.",
                );
        };
        if (/^(png|jpg|jpeg|gif|webp|bmp|ico|avif)$/.test(ext)) {
            const image = element("img");
            image.alt = item.name;
            image.onload = () => {
                if (id === state.previewId)
                    $("preview-body").replaceChildren(image);
            };
            image.onerror = showFailure;
            image.src = src;
        } else if (ext === "svg" || ext === "pdf") {
            const frame = element("iframe");
            frame.title = item.name;
            frame.setAttribute("sandbox", "");
            frame.referrerPolicy = "no-referrer";
            frame.src = src;
            $("preview-body").replaceChildren(frame);
        } else if (
            /^(mp4|webm|mov|m4v|mkv|ogg|ogv)$/.test(ext) ||
            /^(mp3|wav|m4a|flac|aac|oga|opus)$/.test(ext)
        ) {
            const media = element(
                /^(mp3|wav|m4a|flac|aac|oga|opus)$/.test(ext)
                    ? "audio"
                    : "video",
            );
            media.controls = true;
            media.preload = "metadata";
            media.onerror = showFailure;
            media.src = src;
            $("preview-body").replaceChildren(media);
        } else if (
            /^(zip|7z|rar|tar|gz|bz2|xz|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|exe|com|dll|msi|msp|scr|lnk|ico|ttf|otf|woff|woff2|db|sqlite|iso|bin|dat)$/.test(
                ext,
            )
        ) {
            previewMessage(
                "No preview for this file",
                "Download this file to view it.",
            );
        } else {
            try {
                const data = await api(url("/api/text", { path: item.path }));
                if (id !== state.previewId || !$("preview").open) return;
                state.preview.text = data.text;
                state.preview.encoding = data.encoding;
                state.preview.editable = data.editable === true;
                const text = element("pre", "", data.text);
                text.tabIndex = 0;
                $("preview-body").replaceChildren(text);
                $("preview-caption").textContent =
                    `${item.type || "Text file"} · ${bytes(item.size)} · ${data.encoding}${data.editable ? "" : " · Read-only"}`;
                $("edit-button").hidden = !data.editable;
            } catch (error) {
                if (id === state.previewId)
                    previewMessage("Preview unavailable", error.message);
            }
        }
    }
    function previewMessage(title, message) {
        const body = element("div", "preview-message");
        body.append(
            icon("file"),
            element("strong", "", title),
            element("p", "", message),
        );
        $("preview-body").replaceChildren(body);
    }
    function editText() {
        const current = state.preview;
        if (!current || !current.editable || current.editing) return;
        const input = element("textarea");
        input.value = current.text;
        input.spellcheck = false;
        input.setAttribute("aria-label", "File text editor");
        input.addEventListener("input", () => {
            current.dirty = input.value !== current.text;
            $("save-button").disabled = !current.dirty || current.saving;
        });
        current.editing = true;
        $("preview-body").replaceChildren(input);
        $("edit-button").hidden = true;
        $("save-button").hidden = false;
        $("save-button").disabled = true;
        input.focus();
    }
    async function saveText() {
        const current = state.preview;
        if (
            !current?.editing ||
            !current.dirty ||
            current.saving ||
            state.working
        )
            return;
        const input = $("preview-body").querySelector("textarea");
        const text = input.value;
        const location = snapshot();
        current.saving = true;
        input.readOnly = true;
        $("save-button").disabled = true;
        await mutate("Saving text...", async () => {
            const data = await post("/api/text", {
                path: current.item.path,
                text,
                encoding: current.encoding,
            });
            current.text = text;
            current.dirty = false;
            current.item = data.item;
            $("preview-caption").textContent =
                `${data.item.type || "Text file"} · ${bytes(data.item.size)} · ${current.encoding} · Saved`;
            await refreshSnapshot(location);
        });
        current.saving = false;
        input.readOnly = false;
        $("save-button").disabled = !current.dirty;
    }
    async function discardEditor() {
        if (state.preview?.saving) return false;
        if (!state.preview?.dirty) return true;
        const content = element("p", "", "Discard your unsaved text changes?");
        return !!(await showModal("Unsaved changes", content, [
            { label: "Keep editing", value: false },
            { label: "Discard", value: true, className: "danger" },
        ]));
    }
    async function closePreview() {
        if (!(await discardEditor())) return;
        state.previewId++;
        $("preview-body")
            .querySelectorAll("video,audio")
            .forEach((media) => {
                media.pause();
                media.removeAttribute("src");
                media.load();
            });
        $("preview-body").replaceChildren();
        state.preview = null;
        $("preview").close();
        if (state.path !== null) $("file-list").focus();
    }
    $("preview-close").onclick = closePreview;
    $("preview").addEventListener("cancel", (event) => {
        event.preventDefault();
        closePreview();
    });
    $("preview").addEventListener("click", (event) => {
        const action = event.target.closest("[data-preview]")?.dataset.preview;
        if (!action || !state.preview) return;
        if (action === "download") downloadItems([state.preview.item]);
        else if (action === "edit") editText();
        else if (action === "save") saveText();
    });
    window.addEventListener("beforeunload", (event) => {
        if (state.preview?.dirty) {
            event.preventDefault();
            event.returnValue = "";
        }
    });

    function dispatch(action) {
        if (!available(action)) return;
        if (action.startsWith("sort-")) {
            const sort = action.slice(5);
            if (sort === "asc" || sort === "desc") {
                state.direction = sort;
                savePreferences();
                if (state.path !== null && !state.loading) renderFiles();
            } else setSort(sort);
            return;
        }
        switch (action) {
            case "home":
                navigate(null);
                break;
            case "recycle-bin":
                navigate(RECYCLE_BIN);
                break;
            case "restore":
                restoreItems();
                break;
            case "back":
                historyMove(-1);
                break;
            case "forward":
                historyMove(1);
                break;
            case "up":
                navigate(state.parent);
                break;
            case "refresh":
                refresh();
                break;
            case "address":
                startAddress();
                break;
            case "sidebar": {
                const open = $("sidebar").classList.toggle("open");
                document
                    .querySelector('[data-action="sidebar"]')
                    .setAttribute("aria-expanded", String(open));
                break;
            }
            case "details":
            case "grid":
                setView(action);
                break;
            case "hidden":
                state.hidden = !state.hidden;
                savePreferences();
                refresh();
                break;
            case "new-folder":
                createItem("folder");
                break;
            case "new-file":
                createItem("file");
                break;
            case "cut":
                copyItems("move");
                break;
            case "copy":
                copyItems("copy");
                break;
            case "paste":
                pasteItems();
                break;
            case "rename":
                renameItem();
                break;
            case "delete":
                deleteItems();
                break;
            case "download":
                downloadItems(selectedItems());
                break;
            case "upload-files":
            case "upload-folder":
                $(action).click();
                break;
            case "properties":
                properties();
                break;
            case "preview":
                if (selectedItems().length === 1) openItem(selectedItems()[0]);
                break;
            case "select-all":
                state.selected = new Set(state.items.map((item) => item.path));
                updateSelection();
                break;
            case "shortcuts": {
                const list = element("dl", "property-list");
                [
                    ["Alt+Left/Right", "Back / Forward"],
                    ["Alt+Up", "Parent folder"],
                    ["Ctrl+L", "Edit address"],
                    ["Ctrl+F", "Search folder"],
                    ["F5", "Refresh"],
                    ["Ctrl+A", "Select all"],
                    ["Ctrl+Click", "Toggle selection"],
                    ["Shift+Click", "Select a range"],
                    ["Ctrl+X/C/V", "Cut / Copy / Paste"],
                    ["Ctrl+Shift+N", "New folder"],
                    ["F2", "Rename"],
                    ["Delete", "Delete with confirmation"],
                    ["Alt+Enter", "Properties"],
                    ["Enter", "Open folder / Preview file"],
                    ["Ctrl+S", "Save text editor"],
                ].forEach(([key, description]) =>
                    list.append(
                        element("dt", "", key),
                        element("dd", "", description),
                    ),
                );
                showModal("Keyboard shortcuts", list, [
                    { label: "Close", value: false },
                ]);
                break;
            }
        }
    }
    document.addEventListener("keydown", (event) => {
        const control = event.ctrlKey || event.metaKey;
        if ($("modal").open) return;
        if ($("preview").open) {
            if (control && event.key.toLowerCase() === "s") {
                event.preventDefault();
                saveText();
            }
            return;
        }
        const typing = event.target.closest(
            "input,textarea,[contenteditable=true]",
        );
        if (control && event.key.toLowerCase() === "l") {
            event.preventDefault();
            startAddress();
            return;
        }
        if (control && event.key.toLowerCase() === "f") {
            event.preventDefault();
            if (state.path !== null) $("search-input").focus();
            return;
        }
        if (typing) return;
        if (!$("context-menu").hidden) return;
        const key = event.key.toLowerCase();
        if (
            event.altKey &&
            ["arrowleft", "arrowright", "arrowup", "enter"].includes(key)
        ) {
            event.preventDefault();
            dispatch(
                {
                    arrowleft: "back",
                    arrowright: "forward",
                    arrowup: "up",
                    enter: "properties",
                }[key],
            );
            return;
        }
        if (key === "f5") {
            event.preventDefault();
            refresh();
            return;
        }
        if (control && !event.shiftKey && ["a", "x", "c", "v"].includes(key)) {
            event.preventDefault();
            dispatch({ a: "select-all", x: "cut", c: "copy", v: "paste" }[key]);
            return;
        }
        if (control && event.shiftKey && key === "n") {
            event.preventDefault();
            createItem("folder");
            return;
        }
        if (key === "f2") {
            event.preventDefault();
            renameItem();
            return;
        }
        if (key === "delete") {
            event.preventDefault();
            deleteItems();
            return;
        }
        if (key === "escape") {
            state.selected.clear();
            state.clipboard = null;
            updateSelection();
            return;
        }
        if (state.loading || state.path === null || !state.items.length) return;
        if (key === "enter") {
            if (selectedItems().length === 1) openItem(selectedItems()[0]);
            return;
        }
        const listFocused =
            event.target === $("file-list") ||
            !!event.target.closest(".file-row");
        if (!listFocused) return;
        let index = state.ordered.findIndex(
            (item) => item.path === state.focus,
        );
        if (
            [
                "arrowdown",
                "arrowup",
                "arrowleft",
                "arrowright",
                "home",
                "end",
                " ",
            ].includes(key)
        ) {
            event.preventDefault();
            if (key === " " && index >= 0) {
                selectItem(index, control, event.shiftKey);
                return;
            }
            const columns =
                state.view === "grid"
                    ? Math.max(
                          1,
                          getComputedStyle(
                              $("file-list"),
                          ).gridTemplateColumns.split(" ").length,
                      )
                    : 1;
            if (key === "home") index = 0;
            else if (key === "end") index = state.ordered.length - 1;
            else if (index < 0) index = 0;
            else
                index +=
                    key === "arrowdown"
                        ? columns
                        : key === "arrowup"
                          ? -columns
                          : key === "arrowright"
                            ? 1
                            : -1;
            index = Math.max(0, Math.min(state.ordered.length - 1, index));
            if (control && !event.shiftKey) {
                state.focus = state.ordered[index].path;
                updateSelection();
            } else selectItem(index, control, event.shiftKey);
            $("file-list")
                .querySelector(`[data-index="${index}"]`)
                ?.scrollIntoView({ block: "nearest" });
        } else if (
            key.length === 1 &&
            !control &&
            !event.altKey &&
            key.trim()
        ) {
            const now = Date.now();
            state.typeAhead =
                now - state.typeTime > 800 ? key : state.typeAhead + key;
            state.typeTime = now;
            const found = state.ordered.findIndex((item) =>
                item.name.toLowerCase().startsWith(state.typeAhead),
            );
            if (found >= 0) {
                selectItem(found, false, false);
                $("file-list")
                    .querySelector(`[data-index="${found}"]`)
                    ?.scrollIntoView({ block: "nearest" });
            }
        }
    });
    navigate(null);
})();
