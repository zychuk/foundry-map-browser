const MODULE_ID = "zychu-map-browser";

let catalogCache = null;
let browserInstance = null;

/* -------------------------------------------- */
/*  Inicjalizacja i ustawienia                  */
/* -------------------------------------------- */

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "serverUrl", {
        name: "Adres URL serwera map",
        hint: "Pełny adres serwera z plikiem catalog.json (np. https://maps.example.com). Bez ukośnika na końcu.",
                           scope: "world",
                           config: true,
                           type: String,
                           default: "",
                               onChange: () => {
                                   catalogCache = null;
                                   if (browserInstance?.rendered) browserInstance.render();
                               }
    });
});

// Przycisk otwierania przeglądarki w katalogu Scen
Hooks.on("renderSceneDirectory", (app, html) => {
    if (!game.user.isGM) return;

    const root = html instanceof HTMLElement ? html : html[0];
    if (!root || root.querySelector(".zmb-open-btn")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zmb-open-btn";
    btn.innerHTML = `<i class="fa-solid fa-map"></i> Przeglądarka Map`;
    btn.addEventListener("click", () => {
        if (!browserInstance) browserInstance = new HomelabMapBrowser();
        browserInstance.render(true);
    });

    const headerActions = root.querySelector(".directory-header .header-actions");
    if (headerActions) {
        headerActions.appendChild(btn);
    } else {
        root.prepend(btn);
    }
});

// Automatyczne odświeżanie statusu po dodaniu/usunięciu sceny w świecie
Hooks.on("createScene", () => {
    if (browserInstance?.rendered) browserInstance.refreshGridOnly();
});
Hooks.on("deleteScene", () => {
    if (browserInstance?.rendered) browserInstance.refreshGridOnly();
});

/* -------------------------------------------- */
/*  Funkcje pomocnicze i komunikacja z serwerem */
/* -------------------------------------------- */

function getServerUrl() {
    const raw = game.settings.get(MODULE_ID, "serverUrl") || "";
    return raw.trim().replace(/\/+$/, "");
}

function buildRemoteUrl(baseUrl, relativePath) {
    if (!relativePath) return "icons/svg/adastra.svg";
    const encoded = relativePath
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
    return `${baseUrl}/${encoded}`;
}

async function loadCatalog(force = false) {
    const baseUrl = getServerUrl();
    if (!baseUrl) return null;

    if (!catalogCache || force) {
        const response = await fetch(`${baseUrl}/catalog.json`, { cache: "no-cache" });
        if (!response.ok) {
            throw new Error(`Serwer zwrócił kod HTTP ${response.status}`);
        }
        catalogCache = await response.json();
    }
    return catalogCache;
}

/**
 * Sprawdza, czy dana scena z paczki znajduje się już w świecie
 */
function findWorldScene(moduleId, sceneId, bgRelativePath) {
    return game.scenes.find(s => {
        const flagMod = s.getFlag(MODULE_ID, "moduleId");
        const flagScene = s.getFlag(MODULE_ID, "sceneId");
        if (flagMod === moduleId && flagScene === sceneId) return true;

        const currentBg = s.background?.src || s.img || "";
        if (bgRelativePath && currentBg.endsWith(encodeURI(bgRelativePath))) return true;
        return false;
    });
}

/**
 * Zwraca status zaimportowania całej paczki (kompendium) w świecie
 */
function getPackStatus(pack) {
    let importedCount = 0;

    for (const s of pack.scenes) {
        if (findWorldScene(pack.moduleId, s.id, s.bg)) {
            importedCount++;
        }
    }

    return {
        importedCount,
        totalCount: pack.sceneCount || pack.scenes.length,
        isImported: importedCount > 0,
        isFullyImported: importedCount >= (pack.sceneCount || pack.scenes.length)
    };
}

/**
 * Rekurencyjnie podmienia lokalne ścieżki "modules/<id>/..." na pełny adres z serwera
 */
function rewriteScenePaths(obj, baseUrl) {
    if (Array.isArray(obj)) {
        return obj.map(item => rewriteScenePaths(item, baseUrl));
    }
    if (obj && typeof obj === "object") {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === "string" && value.startsWith("modules/")) {
                result[key] = buildRemoteUrl(baseUrl, value);
            } else {
                result[key] = rewriteScenePaths(value, baseUrl);
            }
        }
        return result;
    }
    return obj;
}

/**
 * Znajduje lub tworzy folder dla danej paczki w zakładce Sceny
 */
async function getOrCreatePackFolder(pack) {
    const cleanName = pack.title
    .replace(/^(Cze and Peku - |Czepeku Scenes - |Czepeku - )/i, "")
    .trim();

    let folder = game.folders.find(
        f => f.type === "Scene" && (f.getFlag(MODULE_ID, "moduleId") === pack.moduleId || f.name === cleanName)
    );

    if (!folder) {
        folder = await Folder.create({
            name: cleanName,
            type: "Scene",
            flags: {
                [MODULE_ID]: {
                    moduleId: pack.moduleId,
                    version: pack.version || "1.0.0"
                }
            }
        });
    }
    return folder;
}

/**
 * Importuje całe kompendium (wszystkie brakujące sceny z paczki) do świata
 */
async function importPackToWorld(pack) {
    const baseUrl = getServerUrl();
    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(pack.moduleId)}/scenes.json`;

    const res = await fetch(scenesUrl);
    if (!res.ok) throw new Error(`Nie udało się pobrać pliku scenes.json (HTTP ${res.status})`);

    const rawScenes = await res.json();
    const folder = await getOrCreatePackFolder(pack);

    const toCreate = [];
    for (const raw of rawScenes) {
        const meta = pack.scenes.find(s => s.id === raw._id);
        if (findWorldScene(pack.moduleId, raw._id, meta?.bg)) continue;

        const prepared = rewriteScenePaths(foundry.utils.deepClone(raw), baseUrl);
        const originalId = prepared._id;
        delete prepared._id;

        prepared.folder = folder.id;
        if (meta?.thumb) {
            prepared.thumb = buildRemoteUrl(baseUrl, meta.thumb);
        }
        prepared.flags = foundry.utils.mergeObject(prepared.flags || {}, {
            [MODULE_ID]: {
                moduleId: pack.moduleId,
                sceneId: originalId,
                version: pack.version || "1.0.0"
            }
        });

        toCreate.push(prepared);
    }

    if (toCreate.length === 0) {
        ui.notifications.info(`Wszystkie sceny z paczki "${pack.title}" są już w świecie.`);
        return;
    }

    await Scene.createDocuments(toCreate);
    ui.notifications.info(`Zaimportowano ${toCreate.length} scen z paczki "${pack.title}".`);
}

/**
 * Importuje pojedynczą scenę z paczki
 */
async function importSingleSceneToWorld(pack, sceneMeta) {
    const existing = findWorldScene(pack.moduleId, sceneMeta.id, sceneMeta.bg);
    if (existing) return existing;

    const baseUrl = getServerUrl();
    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(pack.moduleId)}/scenes.json`;

    const res = await fetch(scenesUrl);
    if (!res.ok) throw new Error(`Nie udało się pobrać pliku scenes.json (HTTP ${res.status})`);

    const rawScenes = await res.json();
    const raw = rawScenes.find(s => s._id === sceneMeta.id);
    if (!raw) throw new Error("Nie znaleziono wybranej sceny w pliku scenes.json.");

    const folder = await getOrCreatePackFolder(pack);
    const prepared = rewriteScenePaths(foundry.utils.deepClone(raw), baseUrl);
    delete prepared._id;

    prepared.folder = folder.id;
    if (sceneMeta.thumb) {
        prepared.thumb = buildRemoteUrl(baseUrl, sceneMeta.thumb);
    }
    prepared.flags = foundry.utils.mergeObject(prepared.flags || {}, {
        [MODULE_ID]: {
            moduleId: pack.moduleId,
            sceneId: sceneMeta.id,
            version: pack.version || "1.0.0"
        }
    });

    const created = await Scene.create(prepared);
    ui.notifications.info(`Zaimportowano scenę: ${created.name}`);
    return created;
}

/**
 * Usuwa wszystkie zaimportowane sceny (oraz pusty folder) danej paczki ze świata
 */
async function removePackFromWorld(pack) {
    const scenesToRemove = game.scenes.filter(s => {
        if (s.getFlag(MODULE_ID, "moduleId") === pack.moduleId) return true;
        return pack.scenes.some(meta => meta.bg && (s.background?.src || "").endsWith(encodeURI(meta.bg)));
    });

    if (scenesToRemove.length > 0) {
        await Scene.deleteDocuments(scenesToRemove.map(s => s.id));
    }

    const folder = game.folders.find(
        f => f.type === "Scene" && f.getFlag(MODULE_ID, "moduleId") === pack.moduleId
    );
    if (folder && folder.contents.length === 0) {
        await folder.delete();
    }

    ui.notifications.info(`Usunięto zaimportowane sceny paczki "${pack.title}" ze świata.`);
}

/* -------------------------------------------- */
/*  Okno Przeglądarki (ApplicationV2)           */
/* -------------------------------------------- */

const BaseApp = foundry.applications?.api?.ApplicationV2 ?? Application;

class HomelabMapBrowser extends BaseApp {
    constructor(options = {}) {
        super(options);
        this.filterStatus = "all"; // "all" | "imported" | "not-imported"
        this.filterCategory = "all"; // "all" | "map" | "scene"
        this.searchQuery = "";
        this.selectedPack = null;
        this.gridContainer = null;
        this.countElement = null;
    }

    static DEFAULT_OPTIONS = {
        id: "zychu-map-browser",
        tag: "div",
        classes: ["zychu-map-browser"],
        window: {
            title: "Przeglądarka Map (Homelab)",
            icon: "fa-solid fa-map",
            resizable: true
        },
        position: {
            width: 960,
            height: 700
        }
    };

    async _renderHTML() {
        const wrapper = document.createElement("div");
        wrapper.className = "zmb-container";

        const baseUrl = getServerUrl();
        if (!baseUrl) {
            wrapper.innerHTML = `
            <div class="zmb-empty">
            <p><strong>Brak skonfigurowanego adresu serwera map.</strong></p>
            <p>Ustaw adres URL serwera w ustawieniach modułu FoundryVTT.</p>
            <button type="button" class="zmb-open-settings">
            <i class="fa-solid fa-gear"></i> Otwórz ustawienia modułu
            </button>
            </div>
            `;
            wrapper.querySelector(".zmb-open-settings")?.addEventListener("click", () => {
                new SettingsConfig().render(true);
            });
            return wrapper;
        }

        try {
            await loadCatalog();
        } catch (err) {
            wrapper.innerHTML = `
            <div class="zmb-empty">
            <p><strong>Błąd połączenia z serwerem:</strong> ${baseUrl}</p>
            <p>${err.message}</p>
            <button type="button" class="zmb-retry">
            <i class="fa-solid fa-rotate"></i> Spróbuj ponownie
            </button>
            </div>
            `;
            wrapper.querySelector(".zmb-retry")?.addEventListener("click", () => this.render());
            return wrapper;
        }

        wrapper.innerHTML = `
        <div class="zmb-toolbar">
        <button type="button" class="zmb-back-btn" style="display:none;">
        <i class="fa-solid fa-arrow-left"></i> Wróć
        </button>
        <input type="search" class="zmb-search" placeholder="Szukaj po nazwie..." value="${this.searchQuery}" />
        <select class="zmb-status-filter" title="Filtruj po statusie zaimportowania">
        <option value="all" ${this.filterStatus === "all" ? "selected" : ""}>Status: Wszystkie</option>
        <option value="imported" ${this.filterStatus === "imported" ? "selected" : ""}>Zaimportowane</option>
        <option value="not-imported" ${this.filterStatus === "not-imported" ? "selected" : ""}>Niezaimportowane</option>
        </select>
        <select class="zmb-cat-filter" title="Filtruj po typie">
        <option value="all" ${this.filterCategory === "all" ? "selected" : ""}>Typ: Wszystkie</option>
        <option value="map" ${this.filterCategory === "map" ? "selected" : ""}>Mapy bitewne</option>
        <option value="scene" ${this.filterCategory === "scene" ? "selected" : ""}>Sceny</option>
        </select>
        <button type="button" class="zmb-refresh-btn" title="Odśwież katalog z serwera">
        <i class="fa-solid fa-rotate"></i>
        </button>
        <span class="zmb-count"></span>
        </div>
        <div class="zmb-grid"></div>
        `;

        this._bindToolbarEvents(wrapper);
        this.gridContainer = wrapper.querySelector(".zmb-grid");
        this.countElement = wrapper.querySelector(".zmb-count");
        this.backButton = wrapper.querySelector(".zmb-back-btn");
        this.catSelect = wrapper.querySelector(".zmb-cat-filter");

        this.refreshGridOnly();
        return wrapper;
    }

    _replaceHTML(result, content) {
        content.replaceChildren(result);
    }

    _bindToolbarEvents(wrapper) {
        const searchInput = wrapper.querySelector(".zmb-search");
        const statusSelect = wrapper.querySelector(".zmb-status-filter");
        const catSelect = wrapper.querySelector(".zmb-cat-filter");
        const refreshBtn = wrapper.querySelector(".zmb-refresh-btn");
        const backBtn = wrapper.querySelector(".zmb-back-btn");

        searchInput.addEventListener("input", (ev) => {
            this.searchQuery = ev.target.value.trim().toLowerCase();
            this.refreshGridOnly();
        });

        statusSelect.addEventListener("change", (ev) => {
            this.filterStatus = ev.target.value;
            this.refreshGridOnly();
        });

        catSelect.addEventListener("change", (ev) => {
            this.filterCategory = ev.target.value;
            this.refreshGridOnly();
        });

        refreshBtn.addEventListener("click", async () => {
            try {
                await loadCatalog(true);
                this.refreshGridOnly();
                ui.notifications.info("Odświeżono katalog z serwera.");
            } catch (err) {
                ui.notifications.error(err.message);
            }
        });

        backBtn.addEventListener("click", () => {
            this.selectedPack = null;
            this.refreshGridOnly();
        });
    }

    refreshGridOnly() {
        if (!this.gridContainer || !catalogCache) return;
        if (this.selectedPack) {
            this._renderScenesView(this.selectedPack);
        } else {
            this._renderPacksView();
        }
    }

    _renderPacksView() {
        const baseUrl = getServerUrl();
        this.backButton.style.display = "none";
        this.catSelect.style.display = "";
        this.gridContainer.innerHTML = "";

        const packs = catalogCache.packs || [];
        const filtered = [];

        for (const pack of packs) {
            if (this.filterCategory !== "all" && pack.category !== this.filterCategory) continue;

            if (this.searchQuery) {
                const matchTitle = pack.title.toLowerCase().includes(this.searchQuery);
                const matchId = pack.moduleId.toLowerCase().includes(this.searchQuery);
                const matchScene = pack.scenes.some(s => s.name.toLowerCase().includes(this.searchQuery));
                if (!matchTitle && !matchId && !matchScene) continue;
            }

            const status = getPackStatus(pack);
            if (this.filterStatus === "imported" && !status.isImported) continue;
            if (this.filterStatus === "not-imported" && status.isImported) continue;

            filtered.push({ pack, status });
        }

        this.countElement.textContent = `Wyświetlono: ${filtered.length} / ${packs.length}`;

        if (filtered.length === 0) {
            this.gridContainer.innerHTML = `<div class="zmb-empty" style="grid-column: 1 / -1;">Brak wyników spełniających kryteria filtrów.</div>`;
            return;
        }

        for (const { pack, status } of filtered) {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${status.isImported ? "is-imported" : ""}`;

            const cleanTitle = pack.title
            .replace(/^(Cze and Peku - |Czepeku Scenes - |Czepeku - )/i, "")
            .trim();
            const versionStr = pack.version ? `v${pack.version}` : "v1.0";
            const thumbUrl = buildRemoteUrl(baseUrl, pack.cover);

            let statusLabel = "Niezaimportowano";
            let statusClass = "";
            if (status.isFullyImported) {
                statusLabel = `Zaimportowano (${status.importedCount}/${status.totalCount})`;
                statusClass = "imported";
            } else if (status.isImported) {
                statusLabel = `Częściowo (${status.importedCount}/${status.totalCount})`;
                statusClass = "partial";
            }

            tile.innerHTML = `
            <div class="zmb-thumb" title="Kliknij, aby przejrzeć pojedyncze sceny w tej paczce">
            <img src="${thumbUrl}" loading="lazy" alt="${cleanTitle}" />
            <div class="zmb-meta-overlay">
            <span class="zmb-tag">${pack.category === "scene" ? "Scena" : "Mapa"} • ${status.totalCount}</span>
            <span class="zmb-tag">${versionStr}</span>
            </div>
            <div class="zmb-status-bar ${statusClass}">${statusLabel}</div>
            </div>
            <div class="zmb-body">
            <div class="zmb-title">${cleanTitle}</div>
            <div class="zmb-actions">
            <button type="button" class="zmb-import-pack" ${status.isFullyImported ? "disabled" : ""}>
            <i class="fa-solid fa-file-import"></i> ${status.isFullyImported ? "W świecie" : "Importuj"}
            </button>
            <button type="button" class="zmb-view-scenes" title="Pokaż pojedyncze warianty">
            <i class="fa-solid fa-folder-open"></i> Sceny
            </button>
            ${status.isImported ? `
                <button type="button" class="zmb-icon-btn zmb-delete-pack" title="Usuń zaimportowane sceny tej paczki ze świata">
                <i class="fa-solid fa-trash"></i>
                </button>
                ` : ""}
                </div>
                </div>
                `;

                tile.querySelector(".zmb-thumb").addEventListener("click", () => {
                    this.selectedPack = pack;
                    this.refreshGridOnly();
                });

                tile.querySelector(".zmb-view-scenes").addEventListener("click", () => {
                    this.selectedPack = pack;
                    this.refreshGridOnly();
                });

                tile.querySelector(".zmb-import-pack").addEventListener("click", async (ev) => {
                    const btn = ev.currentTarget;
                    btn.disabled = true;
                    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                    try {
                        await importPackToWorld(pack);
                        this.refreshGridOnly();
                    } catch (err) {
                        ui.notifications.error(err.message);
                        btn.disabled = false;
                        btn.innerHTML = `<i class="fa-solid fa-file-import"></i> Importuj`;
                    }
                });

                tile.querySelector(".zmb-delete-pack")?.addEventListener("click", async () => {
                    const confirmed = await Dialog.confirm({
                        title: "Usuń zaimportowaną paczkę",
                        content: `<p>Czy na pewno chcesz usunąć ze świata wszystkie zaimportowane sceny z paczki <strong>${cleanTitle}</strong>?</p>`
                    });
                    if (confirmed) {
                        await removePackFromWorld(pack);
                        this.refreshGridOnly();
                    }
                });

                this.gridContainer.appendChild(tile);
        }
    }

    _renderScenesView(pack) {
        const baseUrl = getServerUrl();
        this.backButton.style.display = "";
        this.catSelect.style.display = "none";
        this.gridContainer.innerHTML = "";

        const versionStr = pack.version ? `v${pack.version}` : "v1.0";
        const scenes = [];

        for (const sceneMeta of pack.scenes) {
            if (this.searchQuery && !sceneMeta.name.toLowerCase().includes(this.searchQuery)) continue;

            const worldScene = findWorldScene(pack.moduleId, sceneMeta.id, sceneMeta.bg);
            const isImported = Boolean(worldScene);

            if (this.filterStatus === "imported" && !isImported) continue;
            if (this.filterStatus === "not-imported" && isImported) continue;

            scenes.push({ sceneMeta, worldScene, isImported });
        }

        this.countElement.textContent = `${pack.title} (${versionStr}) — Sceny: ${scenes.length}`;

        for (const { sceneMeta, worldScene, isImported } of scenes) {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${isImported ? "is-imported" : ""}`;
            const thumbUrl = buildRemoteUrl(baseUrl, sceneMeta.thumb);

            tile.innerHTML = `
            <div class="zmb-thumb">
            <img src="${thumbUrl}" loading="lazy" alt="${sceneMeta.name}" />
            <div class="zmb-meta-overlay">
            <span class="zmb-tag">${sceneMeta.width || "?"}×${sceneMeta.height || "?"}</span>
            <span class="zmb-tag">${versionStr}</span>
            </div>
            <div class="zmb-status-bar ${isImported ? "imported" : ""}">
            ${isImported ? "Zaimportowano" : "Niezaimportowano"}
            </div>
            </div>
            <div class="zmb-body">
            <div class="zmb-title">${sceneMeta.name}</div>
            <div class="zmb-actions">
            <button type="button" class="zmb-import-scene" ${isImported ? "disabled" : ""}>
            <i class="fa-solid fa-download"></i> ${isImported ? "W świecie" : "Importuj"}
            </button>
            <button type="button" class="zmb-open-scene">
            <i class="fa-solid fa-eye"></i> Otwórz
            </button>
            </div>
            </div>
            `;

            tile.querySelector(".zmb-import-scene").addEventListener("click", async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                try {
                    await importSingleSceneToWorld(pack, sceneMeta);
                    this.refreshGridOnly();
                } catch (err) {
                    ui.notifications.error(err.message);
                    btn.disabled = false;
                }
            });

            tile.querySelector(".zmb-open-scene").addEventListener("click", async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                try {
                    const targetScene = worldScene || (await importSingleSceneToWorld(pack, sceneMeta));
                    this.refreshGridOnly();
                    if (targetScene) targetScene.view();
                } catch (err) {
                    ui.notifications.error(err.message);
                } finally {
                    btn.disabled = false;
                }
            });

            this.gridContainer.appendChild(tile);
        }
    }
}
