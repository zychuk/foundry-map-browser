import { FALLBACK_THUMB, ZMB_CHUNK_SIZE, naturalCollator } from "./constants.js";
import {
    getCatalogCache,
    getServerUrl,
    getCleanPackTitle,
    resolveAssetUrl,
    getPackTotalCount,
    getPackCoverCandidates,
    getSceneThumbCandidates,
    loadCatalog,
    buildWorldSceneIndex,
    findWorldScene,
    getPackStatus,
    openImagePreview
} from "./catalog.js";
import { importPackToWorld, importSingleSceneToWorld, isBulkImporting } from "./importer.js";

/* -------------------------------------------- */
/*  Kolejka asynchronicznego ładowania miniatur */
/* -------------------------------------------- */

export class ThumbnailQueue {
    constructor(concurrency = 4) {
        this.concurrency = concurrency;
        this.active = 0;
        this.queue = [];
        this.observer = null;
        this.generation = 0;
    }

    reset(scrollRoot) {
        this.generation++;
        this.queue = [];
        if (this.observer) this.observer.disconnect();
        if (!scrollRoot) return;

        const currentGen = this.generation;
        this.observer = new IntersectionObserver(
            (entries) => {
                if (this.generation !== currentGen) return;
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        this.observer.unobserve(img);
                        this.enqueue(img, true);
                    }
                }
            },
            { root: scrollRoot, rootMargin: "250px 0px" }
        );
    }

    observe(imgElement) {
        if (this.observer) this.observer.observe(imgElement);
        else this.enqueue(imgElement, false);
    }

    enqueue(img, highPriority = false) {
        if (!img || (img.dataset.queued === "true" && !highPriority)) return;
        img.dataset.queued = "true";

        if (highPriority) {
            const idx = this.queue.indexOf(img);
            if (idx !== -1) this.queue.splice(idx, 1);
            this.queue.unshift(img);
        } else {
            this.queue.push(img);
        }

        this.processNext(this.generation);
    }

    processNext(gen) {
        if (gen !== this.generation) return;
        while (this.active < this.concurrency && this.queue.length > 0) {
            const img = this.queue.shift();
            if (!img || !img.isConnected || img.classList.contains("is-loaded")) continue;
            const src = img.dataset.src;
            if (!src) continue;
            this.active++;
            this.loadSingleImage(img, src, gen);
        }
    }

    loadSingleImage(img, src, gen) {
        const finish = () => {
            this.active = Math.max(0, this.active - 1);
            if (gen === this.generation) {
                setTimeout(() => this.processNext(gen), 20);
            }
        };

        img.onload = () => {
            img.classList.add("is-loaded");
            finish();
        };
        img.onerror = () => {
            if (gen !== this.generation || !img.isConnected) {
                finish();
                return;
            }
            if (Array.isArray(img._fallbacks) && img._fallbacks.length > 0) {
                img.src = img._fallbacks.shift();
                return;
            }
            img.onload = null;
            img.onerror = null;
            img.src = FALLBACK_THUMB;
            img.classList.add("is-loaded");
            finish();
        };
        img.src = src;
    }
}

/* -------------------------------------------- */
/*  Okno Przeglądarki (ApplicationV2)           */
/* -------------------------------------------- */

const BaseApp = foundry.applications?.api?.ApplicationV2 ?? Application;

export class HomelabMapBrowser extends BaseApp {
    constructor(options = {}) {
        super(options);
        this.filterStatus = "all";
        this.filterCategory = "all";
        this.searchQuery = "";
        this.savedPackSearch = "";
        this.savedPackScrollTop = 0;
        this.selectedPack = null;
        this.gridContainer = null;
        this.countElement = null;
        this.searchInput = null;
        this.packImportHeaderBtn = null;
        this.thumbQueue = new ThumbnailQueue(4);
        this.searchTimeout = null;

        this.activeList = [];
        this.renderedCount = 0;
        this.renderTileFn = null;
        this.activeViewType = "";
        this.sentinelEl = null;
        this.sentinelObserver = null;
    }

    static DEFAULT_OPTIONS = {
        id: "zychu-map-browser",
        tag: "div",
        classes: ["zychu-map-browser"],
        window: {
            title: "ZMB.WindowMainTitle",
            icon: "fa-solid fa-map",
            resizable: true
        },
        position: { width: 980, height: 720 }
    };

    get title() {
        return game.i18n.localize("ZMB.WindowMainTitle");
    }

    _onClose(options) {
        super._onClose?.(options);
        clearTimeout(this.searchTimeout);
        this.thumbQueue.reset(null);
        this.sentinelObserver?.disconnect();
    }

    _openPack(pack) {
        this.savedPackSearch = this.searchQuery;
        this.savedPackScrollTop = this.gridContainer?.scrollTop || 0;
        this.searchQuery = "";
        if (this.searchInput) this.searchInput.value = "";
        this.selectedPack = pack;
        this.refreshGridOnly({ scrollTop: 0 });
    }

    _goBackToPacks() {
        this.selectedPack = null;
        this.searchQuery = this.savedPackSearch || "";
        if (this.searchInput) this.searchInput.value = this.searchQuery;
        this.refreshGridOnly({ scrollTop: this.savedPackScrollTop });
    }

    _appendNextChunk() {
        if (!this.renderTileFn || !this.gridContainer || this.renderedCount >= this.activeList.length) {
            return;
        }

        const start = this.renderedCount;
        const end = Math.min(start + ZMB_CHUNK_SIZE, this.activeList.length);
        const fragment = document.createDocumentFragment();
        const imagesToQueue = [];

        for (let idx = start; idx < end; idx++) {
            const tile = this.renderTileFn(this.activeList[idx], idx);
            const imgEl = tile.querySelector("img");
            if (imgEl) imagesToQueue.push(imgEl);
            fragment.appendChild(tile);
        }

        if (this.sentinelEl && this.sentinelEl.parentElement === this.gridContainer) {
            this.gridContainer.insertBefore(fragment, this.sentinelEl);
        } else {
            this.gridContainer.appendChild(fragment);
        }

        this.renderedCount = end;

        for (const img of imagesToQueue) {
            this.thumbQueue.observe(img);
        }

        if (this.renderedCount >= this.activeList.length) {
            this.sentinelObserver?.disconnect();
        }
    }

    _setupChunkedGrid(items, viewType, renderTileFn) {
        this.sentinelObserver?.disconnect();
        this.activeList = items;
        this.renderedCount = 0;
        this.activeViewType = viewType;
        this.renderTileFn = renderTileFn;

        if (!this.sentinelEl) {
            this.sentinelEl = document.createElement("div");
            this.sentinelEl.className = "zmb-sentinel";
        }
        this.gridContainer.appendChild(this.sentinelEl);

        this._appendNextChunk();

        if (this.renderedCount < this.activeList.length) {
            this.sentinelObserver = new IntersectionObserver(
                (entries) => {
                    if (entries[0]?.isIntersecting) {
                        this._appendNextChunk();
                    }
                },
                { root: this.gridContainer, rootMargin: "450px 0px" }
            );
            this.sentinelObserver.observe(this.sentinelEl);
        }
    }

    async _renderHTML() {
        const wrapper = document.createElement("div");
        wrapper.className = "zmb-container";

        const baseUrl = getServerUrl();
        if (!baseUrl) {
            wrapper.innerHTML = `
            <div class="zmb-empty">
                <p><strong>${game.i18n.localize("ZMB.SettingsMissingTitle")}</strong></p>
                <p>${game.i18n.localize("ZMB.SettingsMissingDesc")}</p>
                <button type="button" class="zmb-open-settings">
                    <i class="fa-solid fa-gear"></i> ${game.i18n.localize("ZMB.OpenSettingsBtn")}
                </button>
            </div>`;
            wrapper.querySelector(".zmb-open-settings")?.addEventListener("click", () => {
                game.settings.sheet.render(true);
            });
            return wrapper;
        }

        try {
            await loadCatalog();
        } catch (err) {
            wrapper.innerHTML = `
            <div class="zmb-empty">
                <p><strong>${game.i18n.localize("ZMB.ConnectionError")}</strong> ${foundry.utils.escapeHTML(baseUrl)}</p>
                <p>${foundry.utils.escapeHTML(err.message)}</p>
                <button type="button" class="zmb-retry">
                    <i class="fa-solid fa-rotate"></i> ${game.i18n.localize("ZMB.Retry")}
                </button>
            </div>`;
            wrapper.querySelector(".zmb-retry")?.addEventListener("click", () => this.render());
            return wrapper;
        }

        const safeSearch = foundry.utils.escapeHTML(this.searchQuery);
        wrapper.innerHTML = `
        <div class="zmb-toolbar">
            <button type="button" class="zmb-back-btn" style="display:none;">
                <i class="fa-solid fa-arrow-left"></i> ${game.i18n.localize("ZMB.Back")}
            </button>
            <input type="search" class="zmb-search" placeholder="${foundry.utils.escapeHTML(game.i18n.localize("ZMB.SearchPlaceholder"))}" value="${safeSearch}" />
            <select class="zmb-status-filter">
                <option value="all" ${this.filterStatus === "all" ? "selected" : ""}>${game.i18n.localize("ZMB.StatusAll")}</option>
                <option value="imported" ${this.filterStatus === "imported" ? "selected" : ""}>${game.i18n.localize("ZMB.StatusImported")}</option>
                <option value="not-imported" ${this.filterStatus === "not-imported" ? "selected" : ""}>${game.i18n.localize("ZMB.StatusNotImported")}</option>
            </select>
            <select class="zmb-cat-filter">
                <option value="all" ${this.filterCategory === "all" ? "selected" : ""}>${game.i18n.localize("ZMB.TypeAll")}</option>
                <option value="map" ${this.filterCategory === "map" ? "selected" : ""}>${game.i18n.localize("ZMB.TypeBattlemaps")}</option>
                <option value="scene" ${this.filterCategory === "scene" ? "selected" : ""}>${game.i18n.localize("ZMB.TypeScenes")}</option>
            </select>
            <button type="button" class="zmb-pack-import-header-btn" style="display:none;"></button>
            <button type="button" class="zmb-refresh-btn" title="${foundry.utils.escapeHTML(game.i18n.localize("ZMB.RefreshCatalog"))}">
                <i class="fa-solid fa-rotate"></i>
            </button>
            <span class="zmb-count"></span>
        </div>
        <div class="zmb-grid"></div>`;

        this.gridContainer = wrapper.querySelector(".zmb-grid");
        this.countElement = wrapper.querySelector(".zmb-count");
        this.backButton = wrapper.querySelector(".zmb-back-btn");
        this.catSelect = wrapper.querySelector(".zmb-cat-filter");
        this.searchInput = wrapper.querySelector(".zmb-search");
        this.packImportHeaderBtn = wrapper.querySelector(".zmb-pack-import-header-btn");

        this._bindToolbarEvents(wrapper);
        this._bindGridDelegation();
        this.refreshGridOnly();
        return wrapper;
    }

    _replaceHTML(result, content) {
        content.replaceChildren(result);

        const appEl = this.element;
        const headerEl = appEl?.querySelector?.(".window-header");
        if (headerEl && !headerEl._zmbDragBound) {
            headerEl._zmbDragBound = true;
            headerEl.addEventListener("pointerdown", () => {
                result.classList.add("is-dragging");
                const stopDrag = () => {
                    result.classList.remove("is-dragging");
                    window.removeEventListener("pointerup", stopDrag, true);
                    window.removeEventListener("pointercancel", stopDrag, true);
                };
                window.addEventListener("pointerup", stopDrag, true);
                window.addEventListener("pointercancel", stopDrag, true);
            });
        }
    }

    _bindGridDelegation() {
        if (!this.gridContainer) return;

        this.gridContainer.addEventListener("click", async (ev) => {
            const actionEl = ev.target.closest("[data-action]");
            if (!actionEl) return;
            const tileEl = actionEl.closest(".zmb-tile[data-idx]");
            if (!tileEl) return;

            const idx = Number(tileEl.dataset.idx);
            const item = this.activeList[idx];
            if (!item) return;

            const action = actionEl.dataset.action;

            if (this.activeViewType === "packs") {
                if (action === "open-pack") {
                    this._openPack(item.pack);
                } else if (action === "import-pack") {
                    const btn = actionEl;
                    if (btn.disabled) return;
                    const progressFill = tileEl.querySelector(".zmb-progress-fill");
                    btn.disabled = true;
                    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                    try {
                        await importPackToWorld(item.pack, (current, total) => {
                            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${current}/${total}`;
                            if (progressFill && total > 0) {
                                progressFill.style.width = `${Math.round((current / total) * 100)}%`;
                            }
                        });
                        this.refreshGridOnly({ preserveScroll: true });
                    } catch (err) {
                        ui.notifications.error(err.message);
                        if (progressFill) progressFill.style.width = "0%";
                        if (btn.isConnected) {
                            btn.disabled = false;
                            btn.innerHTML = `<i class="fa-solid fa-file-import"></i> ${game.i18n.localize("ZMB.Import")}`;
                        }
                    }
                }
            } else if (this.activeViewType === "scenes") {
                const pack = this.selectedPack;
                if (!pack) return;
                const { sceneMeta } = item;

                if (action === "preview-scene") {
                    const baseUrl = getServerUrl();
                    const previewUrl = resolveAssetUrl(baseUrl, sceneMeta.bg || sceneMeta.thumb, pack.moduleId);
                    openImagePreview(previewUrl, sceneMeta.name || game.i18n.localize("ZMB.SceneDefaultName"));
                } else if (action === "import-scene") {
                    const btn = actionEl;
                    if (btn.disabled) return;
                    btn.disabled = true;
                    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                    try {
                        await importSingleSceneToWorld(pack, sceneMeta);
                        this.refreshGridOnly({ preserveScroll: true });
                    } catch (err) {
                        ui.notifications.error(err.message);
                        if (btn.isConnected) {
                            btn.disabled = false;
                            btn.innerHTML = `<i class="fa-solid fa-download"></i> ${game.i18n.localize("ZMB.Import")}`;
                        }
                    }
                } else if (action === "open-scene") {
                    const btn = actionEl;
                    if (btn.disabled) return;
                    btn.disabled = true;
                    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                    try {
                        const currentWorldIndex = buildWorldSceneIndex();
                        const existingScene = findWorldScene(currentWorldIndex, pack.moduleId, sceneMeta.id);
                        const targetScene = existingScene || (await importSingleSceneToWorld(pack, sceneMeta));
                        this.refreshGridOnly({ preserveScroll: true });
                        if (targetScene) targetScene.view();
                    } catch (err) {
                        ui.notifications.error(err.message);
                        if (btn.isConnected) {
                            btn.disabled = false;
                            btn.innerHTML = `<i class="fa-solid fa-eye"></i> ${game.i18n.localize("ZMB.Open")}`;
                        }
                    }
                }
            }
        });
    }

    _bindToolbarEvents(wrapper) {
        const statusSelect = wrapper.querySelector(".zmb-status-filter");
        const catSelect = wrapper.querySelector(".zmb-cat-filter");
        const refreshBtn = wrapper.querySelector(".zmb-refresh-btn");
        const backBtn = wrapper.querySelector(".zmb-back-btn");

        wrapper.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape" && this.selectedPack && !isBulkImporting) {
                if (document.activeElement === this.searchInput && this.searchQuery) return;
                ev.preventDefault();
                ev.stopPropagation();
                this._goBackToPacks();
            }
        });

        this.searchInput.addEventListener("input", (ev) => {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.searchQuery = ev.target.value.trim().toLowerCase();
                this.refreshGridOnly({ scrollTop: 0 });
            }, 100);
        });

        statusSelect.addEventListener("change", (ev) => {
            this.filterStatus = ev.target.value;
            this.refreshGridOnly({ scrollTop: 0 });
        });

        catSelect.addEventListener("change", (ev) => {
            this.filterCategory = ev.target.value;
            this.refreshGridOnly({ scrollTop: 0 });
        });

        this.packImportHeaderBtn.addEventListener("click", async (ev) => {
            if (!this.selectedPack) return;
            const pack = this.selectedPack;
            const btn = ev.currentTarget;
            btn.disabled = true;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
            try {
                await importPackToWorld(pack, (current, total) => {
                    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${current}/${total}`;
                });
                this.refreshGridOnly({ preserveScroll: true });
            } catch (err) {
                ui.notifications.error(err.message);
                this.refreshGridOnly({ preserveScroll: true });
            }
        });

        refreshBtn.addEventListener("click", async () => {
            try {
                const updatedCatalog = await loadCatalog(true);
                if (this.selectedPack) {
                    this.selectedPack = (updatedCatalog?.packs || []).find(p => p.moduleId === this.selectedPack.moduleId) || null;
                }
                this.refreshGridOnly({ preserveScroll: true });
                ui.notifications.info(game.i18n.localize("ZMB.CatalogRefreshed"));
            } catch (err) {
                ui.notifications.error(err.message);
            }
        });

        backBtn.addEventListener("click", () => {
            this._goBackToPacks();
        });
    }

    refreshGridOnly(options = {}) {
        const catalogCache = getCatalogCache();
        if (!this.gridContainer || !catalogCache) return;

        const prevScroll = this.gridContainer.scrollTop;
        this.thumbQueue.reset(this.gridContainer);
        this.sentinelObserver?.disconnect();

        if (this.selectedPack) {
            this._renderScenesView(this.selectedPack);
        } else {
            this._renderPacksView(catalogCache);
        }

        const targetScroll = typeof options.scrollTop === "number"
            ? options.scrollTop
            : (options.preserveScroll ? prevScroll : 0);

        if (targetScroll > 0) {
            while (
                this.renderedCount < this.activeList.length &&
                this.gridContainer.scrollHeight < targetScroll + (this.gridContainer.clientHeight || 700)
            ) {
                this._appendNextChunk();
            }
            this.gridContainer.scrollTop = targetScroll;
        } else {
            this.gridContainer.scrollTop = 0;
        }
    }

    _renderPacksView(catalogCache) {
        const baseUrl = getServerUrl();
        const worldIndex = buildWorldSceneIndex();

        this.backButton.style.display = "none";
        this.catSelect.style.display = "";
        this.packImportHeaderBtn.style.display = "none";
        this.gridContainer.innerHTML = "";

        const packs = catalogCache.packs || [];
        const filtered = [];

        for (const pack of packs) {
            if (this.filterCategory !== "all" && pack.category !== this.filterCategory) continue;
            if (this.searchQuery && !(pack._searchBlob || "").includes(this.searchQuery)) continue;

            const status = getPackStatus(pack, worldIndex);
            if (this.filterStatus === "imported" && !status.isImported) continue;
            if (this.filterStatus === "not-imported" && status.isImported) continue;

            filtered.push({ pack, status });
        }

        this.countElement.textContent = `${game.i18n.localize("ZMB.Displayed")}: ${filtered.length} / ${packs.length}`;

        if (filtered.length === 0) {
            this.gridContainer.innerHTML = `<div class="zmb-empty" style="grid-column: 1 / -1;">${game.i18n.localize("ZMB.NoResults")}</div>`;
            return;
        }

        const labelScene = game.i18n.localize("ZMB.SceneType");
        const labelMap = game.i18n.localize("ZMB.MapType");
        const labelNotImp = game.i18n.localize("ZMB.NotImportedLabel");
        const labelImp = game.i18n.localize("ZMB.ImportedLabel");
        const labelPart = game.i18n.localize("ZMB.PartialLabel");
        const labelInWorld = game.i18n.localize("ZMB.InWorld");
        const labelImport = game.i18n.localize("ZMB.Import");
        const labelScenes = game.i18n.localize("ZMB.Scenes");

        this._setupChunkedGrid(filtered, "packs", ({ pack, status }, idx) => {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${status.isImported ? "is-imported" : ""}`;
            tile.dataset.idx = idx;

            const versionStr = pack._versionStr || foundry.utils.escapeHTML(pack.version ? `v${pack.version}` : "v1.0");
            const coverCandidates = getPackCoverCandidates(baseUrl, pack);
            const primaryThumbUrl = coverCandidates[0] || FALLBACK_THUMB;
            const safeTitle = pack._safeTitle || foundry.utils.escapeHTML(getCleanPackTitle(pack));

            const isSceneCat = pack.category === "scene";
            const catLabel = isSceneCat ? labelScene : labelMap;
            const catClass = isSceneCat ? "cat-scene" : "cat-map";

            let statusLabel = labelNotImp;
            let statusClass = "";
            if (status.isFullyImported) {
                statusLabel = `${labelImp} (${status.importedCount}/${status.totalCount})`;
                statusClass = "imported";
            } else if (status.isImported) {
                statusLabel = `${labelPart} (${status.importedCount}/${status.totalCount})`;
                statusClass = "partial";
            }

            tile.innerHTML = `
            <div class="zmb-thumb" data-action="open-pack">
                <img data-src="${foundry.utils.escapeHTML(primaryThumbUrl)}" alt="${safeTitle}" />
                <div class="zmb-meta-overlay">
                    <span class="zmb-tag ${catClass}">${catLabel} • ${status.totalCount}</span>
                    <span class="zmb-tag">${versionStr}</span>
                </div>
                <div class="zmb-status-bar ${statusClass}">
                    <span class="zmb-status-text">${statusLabel}</span>
                    <div class="zmb-progress-fill" style="width: 0%;"></div>
                </div>
            </div>
            <div class="zmb-body">
                <div class="zmb-title" title="${safeTitle}">${safeTitle}</div>
                <div class="zmb-actions">
                    <button type="button" class="zmb-import-pack" data-action="import-pack" ${status.isFullyImported ? "disabled" : ""}>
                        <i class="fa-solid ${status.isFullyImported ? "fa-check" : "fa-file-import"}"></i>
                        ${status.isFullyImported ? labelInWorld : labelImport}
                    </button>
                    <button type="button" class="zmb-view-scenes" data-action="open-pack">
                        <i class="fa-solid fa-folder-open"></i> ${labelScenes}
                    </button>
                </div>
            </div>`;

            const imgEl = tile.querySelector("img");
            imgEl._fallbacks = coverCandidates.slice(1);
            return tile;
        });
    }

    _renderScenesView(pack) {
        const baseUrl = getServerUrl();
        const worldIndex = buildWorldSceneIndex();
        const packStatus = getPackStatus(pack, worldIndex);

        this.backButton.style.display = "";
        this.catSelect.style.display = "none";
        this.packImportHeaderBtn.style.display = "";
        this.packImportHeaderBtn.disabled = packStatus.isFullyImported;
        this.packImportHeaderBtn.innerHTML = `
        <i class="fa-solid ${packStatus.isFullyImported ? "fa-check" : "fa-file-import"}"></i>
        ${packStatus.isFullyImported
            ? `${game.i18n.localize("ZMB.InWorld")} (${packStatus.importedCount}/${packStatus.totalCount})`
            : `${game.i18n.localize("ZMB.ImportPackBtn")} (${packStatus.importedCount}/${packStatus.totalCount})`}`;

        this.gridContainer.innerHTML = "";

        const cleanTitle = getCleanPackTitle(pack);
        const versionStr = pack._versionStr || foundry.utils.escapeHTML(pack.version ? `v${pack.version}` : "v1.0");
        const packScenes = Array.isArray(pack.scenes) ? pack.scenes : [];
        const defaultSceneLabel = game.i18n.localize("ZMB.SceneDefaultName");
        const previewHintTitle = foundry.utils.escapeHTML(game.i18n.localize("ZMB.PreviewImage"));
        const scenes = [];

        for (const sceneMeta of packScenes) {
            const sName = sceneMeta.name || defaultSceneLabel;
            if (this.searchQuery && !sName.toLowerCase().includes(this.searchQuery)) continue;

            const worldScene = findWorldScene(worldIndex, pack.moduleId, sceneMeta.id);
            const isImported = Boolean(worldScene);

            if (this.filterStatus === "imported" && !isImported) continue;
            if (this.filterStatus === "not-imported" && isImported) continue;

            scenes.push({ sceneMeta, worldScene, isImported });
        }

        scenes.sort((a, b) => naturalCollator.compare(a.sceneMeta.name || "", b.sceneMeta.name || ""));

        this.countElement.textContent = `${cleanTitle} (${pack.version ? `v${pack.version}` : "v1.0"}) — ${game.i18n.localize("ZMB.Scenes")}: ${scenes.length} / ${getPackTotalCount(pack)}`;

        if (scenes.length === 0) {
            this.gridContainer.innerHTML = `<div class="zmb-empty" style="grid-column: 1 / -1;">${game.i18n.localize("ZMB.NoResults")}</div>`;
            return;
        }

        const labelImp = game.i18n.localize("ZMB.ImportedLabel");
        const labelNotImp = game.i18n.localize("ZMB.NotImportedLabel");
        const labelInWorld = game.i18n.localize("ZMB.InWorld");
        const labelImport = game.i18n.localize("ZMB.Import");
        const labelOpen = game.i18n.localize("ZMB.Open");

        this._setupChunkedGrid(scenes, "scenes", ({ sceneMeta, isImported }, idx) => {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${isImported ? "is-imported" : ""}`;
            tile.dataset.idx = idx;

            const thumbCandidates = getSceneThumbCandidates(baseUrl, pack, sceneMeta);
            const primaryThumbUrl = thumbCandidates[0] || FALLBACK_THUMB;
            const sceneName = sceneMeta.name || defaultSceneLabel;
            const safeSceneName = foundry.utils.escapeHTML(sceneName);
            const itemStatus = isImported ? labelImp : labelNotImp;

            tile.innerHTML = `
            <div class="zmb-thumb" data-action="preview-scene" title="${previewHintTitle}">
                <img data-src="${foundry.utils.escapeHTML(primaryThumbUrl)}" alt="${safeSceneName}" />
                <div class="zmb-meta-overlay">
                    <span class="zmb-tag">${Number(sceneMeta.width) || "?"}×${Number(sceneMeta.height) || "?"}</span>
                    <span class="zmb-tag">${versionStr}</span>
                </div>
                <div class="zmb-preview-hint"><i class="fa-solid fa-magnifying-glass-plus"></i></div>
                <div class="zmb-status-bar ${isImported ? "imported" : ""}">
                    <span class="zmb-status-text">${itemStatus}</span>
                </div>
            </div>
            <div class="zmb-body">
                <div class="zmb-title" title="${safeSceneName}">${safeSceneName}</div>
                <div class="zmb-actions">
                    <button type="button" class="zmb-import-scene" data-action="import-scene" ${isImported ? "disabled" : ""}>
                        <i class="fa-solid ${isImported ? "fa-check" : "fa-download"}"></i>
                        ${isImported ? labelInWorld : labelImport}
                    </button>
                    <button type="button" class="zmb-open-scene" data-action="open-scene">
                        <i class="fa-solid fa-eye"></i> ${labelOpen}
                    </button>
                </div>
            </div>`;

            const imgEl = tile.querySelector("img");
            imgEl._fallbacks = thumbCandidates.slice(1);
            return tile;
        });
    }
}