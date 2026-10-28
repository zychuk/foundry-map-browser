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
    if (browserInstance?.rendered && !browserInstance.isBulkImporting) {
        browserInstance.refreshGridOnly();
    }
});
Hooks.on("deleteScene", () => {
    if (browserInstance?.rendered && !browserInstance.isBulkImporting) {
        browserInstance.refreshGridOnly();
    }
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
    if (relativePath.startsWith("http://") || relativePath.startsWith("https://")) {
        return relativePath;
    }
    const clean = relativePath.replace(/^\/+/, "");
    const encoded = clean
    .split("/")
    .map(segment => {
        try {
            return encodeURIComponent(decodeURIComponent(segment));
        } catch {
            return encodeURIComponent(segment);
        }
    })
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
 * Buduje szybki indeks O(1) wszystkich zaimportowanych scen w świecie
 */
function buildWorldSceneIndex() {
    const byKey = new Map();
    const byBgUrl = new Map();

    for (const s of game.scenes) {
        const flagMod = s.getFlag(MODULE_ID, "moduleId");
        const flagScene = s.getFlag(MODULE_ID, "sceneId");
        if (flagMod && flagScene) {
            byKey.set(`${flagMod}:${flagScene}`, s);
        }
        const bgSrc = s.background?.src;
        if (bgSrc) {
            byBgUrl.set(bgSrc, s);
        }
    }
    return { byKey, byBgUrl };
}

function findSceneInIndex(worldIndex, baseUrl, moduleId, sceneId, bgRelativePath) {
    const direct = worldIndex.byKey.get(`${moduleId}:${sceneId}`);
    if (direct) return direct;
    if (bgRelativePath) {
        return worldIndex.byBgUrl.get(buildRemoteUrl(baseUrl, bgRelativePath));
    }
    return undefined;
}

function getPackStatusFast(pack, worldIndex, baseUrl) {
    let importedCount = 0;
    for (const s of pack.scenes) {
        if (findSceneInIndex(worldIndex, baseUrl, pack.moduleId, s.id, s.bg)) {
            importedCount++;
        }
    }
    const totalCount = pack.sceneCount || pack.scenes.length;
    return {
        importedCount,
        totalCount,
        isImported: importedCount > 0,
        isFullyImported: importedCount >= totalCount
    };
}

/**
 * Rekurencyjnie podmienia lokalne ścieżki "modules/<id>/..." na pełny adres URL serwera
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
 * Konwertuje stare wartości ścian z Foundry v8/v9 (0, 1, 2) na format Foundry v12-v14 (0, 10, 20)
 */
function normalizeLegacyWalls(walls) {
    if (!Array.isArray(walls)) return [];

    const mapSenseValue = (val) => {
        if (val === 0) return 0;
        if (val === 1) return 20;
        if (val === 2) return 10;
        if ([0, 10, 20, 30, 40].includes(val)) return val;
        return 20;
    };

    const mapMoveValue = (val) => {
        // W Foundry v12-v14 pole "move" akceptuje wyłącznie 0 (NONE) lub 20 (NORMAL)
        return val === 0 ? 0 : 20;
    };

    return walls.map(w => {
        const wall = foundry.utils.deepClone(w);
        delete wall._id;

        const legacySense = wall.sense;
        delete wall.sense;

        wall.move = mapMoveValue(wall.move ?? 20);
        wall.light = mapSenseValue(wall.light ?? legacySense ?? 20);
        wall.sight = mapSenseValue(wall.sight ?? legacySense ?? 20);
        wall.sound = mapSenseValue(wall.sound ?? legacySense ?? 20);

        // Upewnij się, że współrzędne c to tablica 4 liczb
        if (!Array.isArray(wall.c) || wall.c.length !== 4) {
            return null;
        }
        wall.c = wall.c.map(n => Number(n) || 0);

        return wall;
    }).filter(Boolean);
}

/**
 * Przygotowuje i migruje dane sceny (v9 -> v12/v14) oraz podmienia ścieżki na zdalne URL
 */
function prepareSceneData(raw, pack, meta, folderId, baseUrl) {
    const originalId = raw._id;
    const rawBg = meta?.bg || raw.background?.src || raw.img || null;
    const rawThumb = meta?.thumb || raw.thumb || null;

    // 1. Podmień wszystkie ścieżki "modules/..." na pełny URL serwera jeszcze przed migracją
    let prepared = rewriteScenePaths(foundry.utils.deepClone(raw), baseUrl);
    delete prepared._id;

    // 2. Użyj wbudowanej w Foundry migracji danych (konwertuje strukturę ze starszych wersji)
    try {
        if (typeof Scene.migrateData === "function") {
            prepared = Scene.migrateData(prepared);
        }
    } catch (err) {
        console.warn(`[${MODULE_ID}] Ostrzeżenie podczas Scene.migrateData:`, err);
    }

    // 3. Jawnie ustaw tło sceny w background.src (Foundry v12-v14)
    delete prepared.img;
    if (rawBg) {
        prepared.background = foundry.utils.mergeObject(
            typeof prepared.background === "object" && prepared.background ? prepared.background : {},
            { src: buildRemoteUrl(baseUrl, rawBg) }
        );
    }

    // 4. Napraw ściany ze starych wersji Foundry (błąd "move: 1 is not a valid choice")
    if (Array.isArray(prepared.walls)) {
        prepared.walls = normalizeLegacyWalls(prepared.walls);
    }

    // 5. Napraw kafelki (overhead/roof tiles) ze starszego formatu
    if (Array.isArray(prepared.tiles)) {
        for (const tile of prepared.tiles) {
            delete tile._id;
            if (tile.img && !tile.texture?.src) {
                tile.texture = foundry.utils.mergeObject(tile.texture || {}, { src: tile.img });
                delete tile.img;
            }
        }
    }

    // 6. Usuń stare _id z pozostałych kolekcji osadzonych, by uniknąć konfliktów walidacji
    for (const key of ["lights", "sounds", "templates", "tokens", "notes", "drawings"]) {
        if (Array.isArray(prepared[key])) {
            for (const item of prepared[key]) {
                delete item._id;
            }
        }
    }

    // 7. Napraw definicję siatki (Grid) ze starego formatu liczbowego na obiekt
    if (typeof prepared.grid === "number") {
        prepared.grid = {
            size: prepared.grid || 100,
            type: prepared.gridType ?? 1,
            distance: prepared.gridDistance ?? 5,
            units: prepared.gridUnits || "ft",
            color: prepared.gridColor || "#000000",
            alpha: prepared.gridAlpha ?? 0.2
        };
    }

    prepared.folder = folderId;
    if (rawThumb) {
        prepared.thumb = buildRemoteUrl(baseUrl, rawThumb);
    }

    prepared.flags = foundry.utils.mergeObject(prepared.flags || {}, {
        [MODULE_ID]: {
            moduleId: pack.moduleId,
            sceneId: originalId,
            version: pack.version || "1.0.0"
        }
    });

    return prepared;
}

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

async function importPackToWorld(pack) {
    const baseUrl = getServerUrl();
    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(pack.moduleId)}/scenes.json`;

    const res = await fetch(scenesUrl);
    if (!res.ok) throw new Error(`Nie udało się pobrać pliku scenes.json (HTTP ${res.status})`);

    const rawScenes = await res.json();
    const folder = await getOrCreatePackFolder(pack);
    const worldIndex = buildWorldSceneIndex();

    const toCreate = [];
    for (const raw of rawScenes) {
        const meta = pack.scenes.find(s => s.id === raw._id);
        if (findSceneInIndex(worldIndex, baseUrl, pack.moduleId, raw._id, meta?.bg)) continue;

        toCreate.push(prepareSceneData(raw, pack, meta, folder.id, baseUrl));
    }

    if (toCreate.length === 0) {
        ui.notifications.info(`Wszystkie sceny z paczki "${pack.title}" są już w świecie.`);
        return;
    }

    if (browserInstance) browserInstance.isBulkImporting = true;
    let createdDocs = [];
    try {
        createdDocs = await Scene.createDocuments(toCreate);
    } finally {
        if (browserInstance) browserInstance.isBulkImporting = false;
    }

    ui.notifications.info(`Zaimportowano ${createdDocs?.length || toCreate.length} scen z paczki "${pack.title}".`);
}

async function importSingleSceneToWorld(pack, sceneMeta) {
    const baseUrl = getServerUrl();
    const worldIndex = buildWorldSceneIndex();
    const existing = findSceneInIndex(worldIndex, baseUrl, pack.moduleId, sceneMeta.id, sceneMeta.bg);
    if (existing) return existing;

    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(pack.moduleId)}/scenes.json`;
    const res = await fetch(scenesUrl);
    if (!res.ok) throw new Error(`Nie udało się pobrać pliku scenes.json (HTTP ${res.status})`);

    const rawScenes = await res.json();
    const raw = rawScenes.find(s => s._id === sceneMeta.id);
    if (!raw) throw new Error("Nie znaleziono wybranej sceny w pliku scenes.json.");

    const folder = await getOrCreatePackFolder(pack);
    const prepared = prepareSceneData(raw, pack, sceneMeta, folder.id, baseUrl);

    const created = await Scene.create(prepared);
    if (!created) {
        throw new Error(`Nie udało się utworzyć sceny "${sceneMeta.name}" (błąd walidacji dokumentu).`);
    }

    ui.notifications.info(`Zaimportowano scenę: ${created.name}`);
    return created;
}

async function removePackFromWorld(pack) {
    const baseUrl = getServerUrl();
    const expectedBgs = new Set(pack.scenes.map(s => s.bg ? buildRemoteUrl(baseUrl, s.bg) : null).filter(Boolean));

    const scenesToRemove = game.scenes.filter(s => {
        if (s.getFlag(MODULE_ID, "moduleId") === pack.moduleId) return true;
        return s.background?.src && expectedBgs.has(s.background.src);
    });

    if (browserInstance) browserInstance.isBulkImporting = true;
    try {
        if (scenesToRemove.length > 0) {
            await Scene.deleteDocuments(scenesToRemove.map(s => s.id));
        }

        const folder = game.folders.find(
            f => f.type === "Scene" && f.getFlag(MODULE_ID, "moduleId") === pack.moduleId
        );
        if (folder && folder.contents.length === 0) {
            await folder.delete();
        }
    } finally {
        if (browserInstance) browserInstance.isBulkImporting = false;
    }

    ui.notifications.info(`Usunięto zaimportowane sceny paczki "${pack.title}" ze świata.`);
}

/* -------------------------------------------- */
/*  Kolejka asynchronicznego ładowania miniatur */
/* -------------------------------------------- */

class ThumbnailQueue {
    constructor(concurrency = 3) {
        this.concurrency = concurrency;
        this.active = 0;
        this.queue = [];
        this.observer = null;
        this.generation = 0;
    }

    reset(scrollRoot) {
        this.generation++;
        this.queue = [];
        if (this.observer) {
            this.observer.disconnect();
        }

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
            {
                root: scrollRoot,
                rootMargin: "250px 0px"
            }
        );
    }

    observe(imgElement) {
        if (this.observer) {
            this.observer.observe(imgElement);
        }
        this.enqueue(imgElement, false);
    }

    enqueue(img, highPriority = false) {
        if (!img || (img.dataset.queued === "true" && !highPriority)) return;

        if (highPriority) {
            const idx = this.queue.indexOf(img);
            if (idx !== -1) this.queue.splice(idx, 1);
            this.queue.unshift(img);
        } else {
            img.dataset.queued = "true";
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
            img.src = "icons/svg/adastra.svg";
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

class HomelabMapBrowser extends BaseApp {
    constructor(options = {}) {
        super(options);
        this.filterStatus = "all";
        this.filterCategory = "all";
        this.searchQuery = "";
        this.selectedPack = null;
        this.gridContainer = null;
        this.countElement = null;
        this.thumbQueue = new ThumbnailQueue(3);
        this.searchTimeout = null;
        this.isBulkImporting = false;
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
            width: 980,
            height: 720
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
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.searchQuery = ev.target.value.trim().toLowerCase();
                this.refreshGridOnly();
            }, 120);
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
        this.thumbQueue.reset(this.gridContainer);

        if (this.selectedPack) {
            this._renderScenesView(this.selectedPack);
        } else {
            this._renderPacksView();
        }
    }

    _renderPacksView() {
        const baseUrl = getServerUrl();
        const worldIndex = buildWorldSceneIndex();

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
                const matchScene = pack.scenes.some(s => (s.name || "").toLowerCase().includes(this.searchQuery));
                if (!matchTitle && !matchId && !matchScene) continue;
            }

            const status = getPackStatusFast(pack, worldIndex, baseUrl);
            if (this.filterStatus === "imported" && !status.isImported) continue;
            if (this.filterStatus === "not-imported" && status.isImported) continue;

            filtered.push({ pack, status });
        }

        this.countElement.textContent = `Wyświetlono: ${filtered.length} / ${packs.length}`;

        if (filtered.length === 0) {
            this.gridContainer.innerHTML = `<div class="zmb-empty" style="grid-column: 1 / -1;">Brak wyników spełniających kryteria filtrów.</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();
        const imagesToQueue = [];

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
            <img data-src="${thumbUrl}" alt="${cleanTitle}" />
            <div class="zmb-meta-overlay">
            <span class="zmb-tag">${pack.category === "scene" ? "Scena" : "Mapa"} • ${status.totalCount}</span>
            <span class="zmb-tag">${versionStr}</span>
            </div>
            <div class="zmb-status-bar ${statusClass}">${statusLabel}</div>
            </div>
            <div class="zmb-body">
            <div class="zmb-title" title="${cleanTitle}">${cleanTitle}</div>
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

                imagesToQueue.push(tile.querySelector("img"));

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

                fragment.appendChild(tile);
        }

        this.gridContainer.appendChild(fragment);
        for (const img of imagesToQueue) {
            this.thumbQueue.observe(img);
        }
    }

    _renderScenesView(pack) {
        const baseUrl = getServerUrl();
        const worldIndex = buildWorldSceneIndex();

        this.backButton.style.display = "";
        this.catSelect.style.display = "none";
        this.gridContainer.innerHTML = "";

        const versionStr = pack.version ? `v${pack.version}` : "v1.0";
        const scenes = [];

        for (const sceneMeta of pack.scenes) {
            const sName = sceneMeta.name || "Bez nazwy";
            if (this.searchQuery && !sName.toLowerCase().includes(this.searchQuery)) continue;

            const worldScene = findSceneInIndex(worldIndex, baseUrl, pack.moduleId, sceneMeta.id, sceneMeta.bg);
            const isImported = Boolean(worldScene);

            if (this.filterStatus === "imported" && !isImported) continue;
            if (this.filterStatus === "not-imported" && isImported) continue;

            scenes.push({ sceneMeta, worldScene, isImported });
        }

        this.countElement.textContent = `${pack.title} (${versionStr}) — Sceny: ${scenes.length}`;

        const fragment = document.createDocumentFragment();
        const imagesToQueue = [];

        for (const { sceneMeta, worldScene, isImported } of scenes) {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${isImported ? "is-imported" : ""}`;
            const thumbUrl = buildRemoteUrl(baseUrl, sceneMeta.thumb);
            const sceneName = sceneMeta.name || "Scena";

            tile.innerHTML = `
            <div class="zmb-thumb">
            <img data-src="${thumbUrl}" alt="${sceneName}" />
            <div class="zmb-meta-overlay">
            <span class="zmb-tag">${sceneMeta.width || "?"}×${sceneMeta.height || "?"}</span>
            <span class="zmb-tag">${versionStr}</span>
            </div>
            <div class="zmb-status-bar ${isImported ? "imported" : ""}">
            ${isImported ? "Zaimportowano" : "Niezaimportowano"}
            </div>
            </div>
            <div class="zmb-body">
            <div class="zmb-title" title="${sceneName}">${sceneName}</div>
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

            imagesToQueue.push(tile.querySelector("img"));

            tile.querySelector(".zmb-import-scene").addEventListener("click", async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                try {
                    await importSingleSceneToWorld(pack, sceneMeta);
                    this.refreshGridOnly();
                } catch (err) {
                    ui.notifications.error(err.message);
                    btn.disabled = false;
                    btn.innerHTML = `<i class="fa-solid fa-download"></i> Importuj`;
                }
            });

            tile.querySelector(".zmb-open-scene").addEventListener("click", async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                try {
                    const targetScene = worldScene || (await importSingleSceneToWorld(pack, sceneMeta));
                    this.refreshGridOnly();
                    if (targetScene) targetScene.view();
                } catch (err) {
                    ui.notifications.error(err.message);
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = `<i class="fa-solid fa-eye"></i> Otwórz`;
                }
            });

            fragment.appendChild(tile);
        }

        this.gridContainer.appendChild(fragment);
        for (const img of imagesToQueue) {
            this.thumbQueue.observe(img);
        }
    }
}
