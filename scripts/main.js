const MODULE_ID = "zychu-map-browser";
const FOLDER_NAME = "Zychu Maps";

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

// Przycisk otwierania przeglądarki wyłącznie w katalogu Kompendiów
Hooks.on("renderCompendiumDirectory", (app, html) => {
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

/* -------------------------------------------- */
/*  Funkcje pomocnicze i budowanie URL          */
/* -------------------------------------------- */

function getServerUrl() {
    const raw = game.settings.get(MODULE_ID, "serverUrl") || "";
    return raw.trim().replace(/\/+$/, "");
}

/**
 * Koduje ścieżkę w dwóch wariantach:
 * - decodeFirst = true: dla ścieżek, które są już częściowo zakodowane URL-em (np. %20 -> spacja na dysku)
 * - decodeFirst = false: dla ścieżek, które mają dosłowne znaki %20 w nazwie pliku na dysku Linuksa
 */
function buildRemoteUrl(baseUrl, relativePath, decodeFirst = true) {
    if (!relativePath || typeof relativePath !== "string") return "";
    const trimmed = relativePath.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
        return trimmed;
    }
    if (trimmed.startsWith("icons/") || trimmed.startsWith("ui/")) {
        return trimmed;
    }

    const clean = trimmed.replace(/^\/+/, "");
    const encoded = clean
    .split("/")
    .map(segment => {
        if (!decodeFirst) return encodeURIComponent(segment);
        try {
            return encodeURIComponent(decodeURIComponent(segment));
        } catch {
            return encodeURIComponent(segment);
        }
    })
    .join("/");
    return `${baseUrl}/${encoded}`;
}

function normalizeRelativeModulePath(assetPath, moduleId) {
    if (!assetPath || typeof assetPath !== "string") return "";
    const clean = assetPath.trim().replace(/^\/+/, "");
    if (!clean) return "";
    if (clean.startsWith("http://") || clean.startsWith("https://") || clean.startsWith("data:")) {
        return clean;
    }
    if (clean.startsWith("icons/") || clean.startsWith("ui/")) {
        return clean;
    }
    if (clean.startsWith("modules/") || clean.startsWith("thumbs/")) {
        return clean;
    }
    return `modules/${moduleId}/${clean}`;
}

function resolveAssetUrl(baseUrl, assetPath, moduleId, decodeFirst = true) {
    const norm = normalizeRelativeModulePath(assetPath, moduleId);
    if (!norm) return "";
    return buildRemoteUrl(baseUrl, norm, decodeFirst);
}

/**
 * Sprawdza, który wariant kodowania URL (z dekodowaniem %20 lub z dosłownym %20 na dysku)
 * faktycznie istnieje na serwerze dla danej paczki.
 */
async function detectWorkingUrlEncoding(baseUrl, pack, rawScenes) {
    const firstRaw = rawScenes?.[0];
    const firstMeta = pack.scenes?.[0];
    const samplePath = firstMeta?.bg || firstRaw?.background?.src || firstRaw?.img;
    if (!samplePath) return { decodeFirst: true, forceModulePrefix: false };

    const candidates = [
        { decodeFirst: true, forceModulePrefix: false },
        { decodeFirst: false, forceModulePrefix: false },
        { decodeFirst: true, forceModulePrefix: true },
        { decodeFirst: false, forceModulePrefix: true }
    ];

    for (const cand of candidates) {
        let testRel = normalizeRelativeModulePath(samplePath, pack.moduleId);
        if (cand.forceModulePrefix && testRel.startsWith("modules/")) {
            const parts = testRel.split("/");
            parts[1] = pack.moduleId;
            testRel = parts.join("/");
        }
        const testUrl = buildRemoteUrl(baseUrl, testRel, cand.decodeFirst);
        try {
            const resp = await fetch(testUrl, { method: "HEAD" });
            if (resp.ok) return cand;
        } catch {
            // Próbuj kolejny wariant
        }
    }

    // Jeśli wszystkie zwróciły błąd (np. 404), wypisz czytelne ostrzeżenie w konsoli
    const defaultUrl = resolveAssetUrl(baseUrl, samplePath, pack.moduleId, true);
    console.warn(`[${MODULE_ID}] Nie udało się zweryfikować pliku obrazu tła (sprawdź czy plik istnieje na serwerze): ${defaultUrl}`);
    return { decodeFirst: true, forceModulePrefix: false };
}

function buildFinalAssetUrl(baseUrl, assetPath, moduleId, encodingStrategy) {
    if (!assetPath || typeof assetPath !== "string") return "";
    let rel = normalizeRelativeModulePath(assetPath, moduleId);
    if (encodingStrategy?.forceModulePrefix && rel.startsWith("modules/")) {
        const parts = rel.split("/");
        parts[1] = moduleId;
        rel = parts.join("/");
    }
    return buildRemoteUrl(baseUrl, rel, encodingStrategy ? encodingStrategy.decodeFirst : true);
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

/* -------------------------------------------- */
/*  Zarządzanie Kompendiami i Folderem          */
/* -------------------------------------------- */

function getCompendiumSlug(moduleId) {
    const slug = moduleId.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    return `zmb-${slug}`;
}

function findPackCompendium(pack) {
    const expectedName = getCompendiumSlug(pack.moduleId);
    return game.packs.find(p => {
        if (p.documentName !== "Scene") return false;
        if (p.metadata.name === expectedName) return true;
        if (p.metadata.flags?.[MODULE_ID]?.moduleId === pack.moduleId) return true;
        return false;
    });
}

function getPackStatus(pack) {
    const compendium = findPackCompendium(pack);
    const totalCount = pack.sceneCount || pack.scenes.length;

    if (!compendium) {
        return {
            compendium: null,
            importedCount: 0,
            totalCount,
            isImported: false,
            isFullyImported: false
        };
    }

    const indexedCount = compendium.index ? compendium.index.size : totalCount;
    const importedCount = indexedCount > 0 ? indexedCount : totalCount;

    return {
        compendium,
        importedCount,
        totalCount,
        isImported: true,
        isFullyImported: importedCount >= totalCount
    };
}

/**
 * Znajduje lub tworzy folder "Zychu Maps" w zakładce Compendium Packs
 * (i przemianowuje stary folder "Homelab Maps", jeśli istnieje)
 */
async function getOrCreateCompendiumFolder() {
    let folder = game.folders.find(f => f.type === "Compendium" && f.name === FOLDER_NAME);
    if (folder) return folder;

    const legacyFolder = game.folders.find(f => f.type === "Compendium" && f.name === "Homelab Maps");
    if (legacyFolder) {
        await legacyFolder.update({ name: FOLDER_NAME });
        return legacyFolder;
    }

    try {
        folder = await Folder.create({
            name: FOLDER_NAME,
            type: "Compendium",
            color: "#2e5a44"
        });
        return folder;
    } catch (err) {
        console.warn(`[${MODULE_ID}] Nie udało się utworzyć folderu kompendiów:`, err);
        return null;
    }
}

/**
 * Przypisuje kompendium do folderu Zychu Maps w Foundry v12-v14
 */
async function assignCompendiumToFolder(compendium, folder) {
    if (!compendium || !folder) return;
    try {
        if (typeof compendium.setFolder === "function") {
            await compendium.setFolder(folder.id);
        } else if (typeof compendium.configure === "function") {
            await compendium.configure({ folder: folder.id });
        }
    } catch (err) {
        console.warn(`[${MODULE_ID}] Błąd przypisywania kompendium do folderu:`, err);
    }
}

/* -------------------------------------------- */
/*  Konwersja i naprawa danych Sceny (v9 -> v14)*/
/* -------------------------------------------- */

function normalizeLegacyWalls(walls) {
    if (!Array.isArray(walls)) return [];

    const mapSense = (val) => {
        if (val === 0) return 0;
        if (val === 1) return 20;
        if (val === 2) return 10;
        if ([0, 10, 20, 30, 40].includes(val)) return val;
        return 20;
    };

    return walls.map(w => {
        const wall = foundry.utils.deepClone(w);
        delete wall._id;

        const legacySense = wall.sense;
        delete wall.sense;

        wall.move = wall.move === 0 ? 0 : 20;
        wall.light = mapSense(wall.light ?? legacySense ?? 20);
        wall.sight = mapSense(wall.sight ?? legacySense ?? 20);
        wall.sound = mapSense(wall.sound ?? legacySense ?? 20);

        if (!Array.isArray(wall.c) || wall.c.length !== 4) return null;
        wall.c = wall.c.map(n => Number(n) || 0);

        return wall;
    }).filter(Boolean);
}

function rewriteAllPaths(obj, baseUrl, moduleId, encodingStrategy) {
    if (Array.isArray(obj)) {
        return obj.map(item => rewriteAllPaths(item, baseUrl, moduleId, encodingStrategy));
    }
    if (obj && typeof obj === "object") {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === "string" && (
                value.startsWith("modules/") ||
                /\.(webp|png|jpg|jpeg|ogg|mp3|wav|webm|mp4)$/i.test(value)
            )) {
                result[key] = buildFinalAssetUrl(baseUrl, value, moduleId, encodingStrategy);
            } else {
                result[key] = rewriteAllPaths(value, baseUrl, moduleId, encodingStrategy);
            }
        }
        return result;
    }
    return obj;
}

/**
 * Przygotowuje obiekt sceny z gwarancją poprawnego załadowania obrazu tła (background.src)
 */
function prepareSceneData(raw, pack, meta, baseUrl, encodingStrategy) {
    const originalId = raw._id;

    // 1. Priorytet ma meta.bg z catalog.json (ścieżka zweryfikowana na dysku przy generowaniu miniaturek)
    const rawBgPath =
    meta?.bg ||
    raw.background?.src ||
    raw.img ||
    null;

    const finalBgUrl = rawBgPath
    ? buildFinalAssetUrl(baseUrl, rawBgPath, pack.moduleId, encodingStrategy)
    : null;

    // 2. Miniaturka sceny (z katalogu thumbs/)
    const rawThumbPath = meta?.thumb || raw.thumb || rawBgPath;
    const finalThumbUrl = rawThumbPath
    ? resolveAssetUrl(baseUrl, rawThumbPath, pack.moduleId, true)
    : null;

    // 3. Klonuj i podmień wszystkie ścieżki wewnątrz obiektu
    let prepared = rewriteAllPaths(foundry.utils.deepClone(raw), baseUrl, pack.moduleId, encodingStrategy);
    delete prepared._id;

    if (finalBgUrl) {
        prepared.img = finalBgUrl;
        prepared.background = foundry.utils.mergeObject(
            typeof prepared.background === "object" && prepared.background ? prepared.background : {},
            { src: finalBgUrl }
        );
    }

    // 4. Przepuść przez natywny migrator Foundry
    try {
        if (typeof Scene.migrateData === "function") {
            prepared = Scene.migrateData(prepared);
        }
    } catch (err) {
        console.warn(`[${MODULE_ID}] Scene.migrateData warning:`, err);
    }

    // 5. Po migracji zachowaj zarówno background.src jak i img (aby powtórna migracja w Scene.create nie wyczyściła tła)
    if (finalBgUrl) {
        prepared.img = finalBgUrl;
        if (typeof prepared.background !== "object" || !prepared.background) {
            prepared.background = {};
        }
        prepared.background.src = finalBgUrl;
    }

    if (finalThumbUrl) {
        prepared.thumb = finalThumbUrl;
    }

    // Upewnij się, że wymiary sceny są ustawione
    if (!prepared.width && meta?.width) prepared.width = Number(meta.width);
    if (!prepared.height && meta?.height) prepared.height = Number(meta.height);

    // 6. Napraw ściany ze starych wersji Foundry (move: 1 -> 20)
    if (Array.isArray(prepared.walls)) {
        prepared.walls = normalizeLegacyWalls(prepared.walls);
    }

    // 7. Napraw kafelki (Tiles)
    if (Array.isArray(prepared.tiles)) {
        for (const tile of prepared.tiles) {
            delete tile._id;
            const tileSrc = tile.texture?.src || tile.img;
            if (tileSrc) {
                tile.texture = foundry.utils.mergeObject(tile.texture || {}, {
                    src: buildFinalAssetUrl(baseUrl, tileSrc, pack.moduleId, encodingStrategy)
                });
            }
            delete tile.img;
        }
    }

    for (const key of ["lights", "sounds", "templates", "tokens", "notes", "drawings"]) {
        if (Array.isArray(prepared[key])) {
            for (const item of prepared[key]) {
                delete item._id;
            }
        }
    }

    // 8. Napraw siatkę (Grid) ze starego formatu liczbowego
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

    prepared.flags = foundry.utils.mergeObject(prepared.flags || {}, {
        [MODULE_ID]: {
            moduleId: pack.moduleId,
            sceneId: originalId,
            version: pack.version || "1.0.0",
            bgUrl: finalBgUrl
        }
    });

    return prepared;
}

/* -------------------------------------------- */
/*  Akcje Importu i Usuwania Kompendiów         */
/* -------------------------------------------- */

async function importPackAsCompendium(pack) {
    const baseUrl = getServerUrl();
    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(pack.moduleId)}/scenes.json`;

    const res = await fetch(scenesUrl);
    if (!res.ok) throw new Error(`Nie udało się pobrać pliku scenes.json (HTTP ${res.status})`);

    const rawScenes = await res.json();
    const encodingStrategy = await detectWorkingUrlEncoding(baseUrl, pack, rawScenes);

    const cleanTitle = pack.title
    .replace(/^(Cze and Peku - |Czepeku Scenes - |Czepeku - )/i, "")
    .trim();

    const compFolder = await getOrCreateCompendiumFolder();
    let compendium = findPackCompendium(pack);

    if (!compendium) {
        const compName = getCompendiumSlug(pack.moduleId);
        compendium = await CompendiumCollection.createCompendium({
            name: compName,
            label: cleanTitle,
            type: "Scene",
            package: "world",
            flags: {
                [MODULE_ID]: {
                    moduleId: pack.moduleId,
                    version: pack.version || "1.0.0"
                }
            }
        });
    }

    // Przypisz kompendium do folderu "Zychu Maps"
    if (compFolder) {
        await assignCompendiumToFolder(compendium, compFolder);
    }

    if (compendium.locked) {
        await compendium.configure({ locked: false });
    }

    await compendium.getIndex({ fields: ["name", "flags"] });
    const existingNames = new Set(compendium.index.map(i => i.name));

    const toCreate = [];
    for (const raw of rawScenes) {
        if (existingNames.has(raw.name)) continue;
        const meta = pack.scenes.find(s => s.id === raw._id);
        toCreate.push(prepareSceneData(raw, pack, meta, baseUrl, encodingStrategy));
    }

    if (toCreate.length > 0) {
        await Scene.createDocuments(toCreate, { pack: compendium.collection });
        await compendium.getIndex({ fields: ["name", "flags"] });
    }

    ui.compendium?.render(true);
    ui.notifications.info(`Utworzono kompendium "${cleanTitle}" w folderze ${FOLDER_NAME} (${toCreate.length} scen).`);
    return compendium;
}

async function importSingleSceneToWorld(pack, sceneMeta) {
    const baseUrl = getServerUrl();

    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(pack.moduleId)}/scenes.json`;
    const res = await fetch(scenesUrl);
    if (!res.ok) throw new Error(`Nie udało się pobrać pliku scenes.json (HTTP ${res.status})`);

    const rawScenes = await res.json();
    const raw = rawScenes.find(s => s._id === sceneMeta.id);
    if (!raw) throw new Error("Nie znaleziono wybranej sceny w pliku scenes.json.");

    const encodingStrategy = await detectWorkingUrlEncoding(baseUrl, pack, [raw]);
    const prepared = prepareSceneData(raw, pack, sceneMeta, baseUrl, encodingStrategy);

    // Jeśli scena jest już w świecie (np. ze starszego importu bez tła), napraw jej background.src
    const existing = game.scenes.find(s =>
    s.getFlag(MODULE_ID, "moduleId") === pack.moduleId &&
    s.getFlag(MODULE_ID, "sceneId") === sceneMeta.id
    );
    if (existing) {
        if (prepared.background?.src && existing.background?.src !== prepared.background.src) {
            await existing.update({
                "background.src": prepared.background.src,
                thumb: prepared.thumb || existing.thumb
            });
        }
        return existing;
    }

    const created = await Scene.create(prepared);
    if (!created) {
        throw new Error(`Nie udało się utworzyć sceny "${sceneMeta.name}".`);
    }

    ui.notifications.info(`Zaimportowano scenę do świata: ${created.name}`);
    return created;
}

async function deletePackCompendium(pack) {
    const compendium = findPackCompendium(pack);
    if (!compendium) return;

    if (compendium.locked) {
        await compendium.configure({ locked: false });
    }
    await compendium.deleteCompendium();
    ui.notifications.info(`Usunięto kompendium "${pack.title}".`);
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
    }

    static DEFAULT_OPTIONS = {
        id: "zychu-map-browser",
        tag: "div",
        classes: ["zychu-map-browser"],
        window: {
            title: "Zychu's Map Browser",
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

        const fragment = document.createDocumentFragment();
        const imagesToQueue = [];

        for (const { pack, status } of filtered) {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${status.isImported ? "is-imported" : ""}`;

            const cleanTitle = pack.title
            .replace(/^(Cze and Peku - |Czepeku Scenes - |Czepeku - )/i, "")
            .trim();
            const versionStr = pack.version ? `v${pack.version}` : "v1.0";
            const thumbUrl = resolveAssetUrl(baseUrl, pack.cover, pack.moduleId, true);

            const statusLabel = status.isImported
            ? `W kompendium (${status.totalCount})`
            : "Niezaimportowano";
            const statusClass = status.isImported ? "imported" : "";

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
            <button type="button" class="zmb-import-pack">
            <i class="fa-solid ${status.isImported ? "fa-book-open" : "fa-file-import"}"></i>
            ${status.isImported ? "Kompendium" : "Importuj"}
            </button>
            <button type="button" class="zmb-view-scenes" title="Pokaż pojedyncze warianty">
            <i class="fa-solid fa-folder-open"></i> Warianty
            </button>
            ${status.isImported ? `
                <button type="button" class="zmb-icon-btn zmb-delete-pack" title="Usuń kompendium tej paczki">
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
                    if (status.isImported && status.compendium) {
                        const compFolder = await getOrCreateCompendiumFolder();
                        if (compFolder && !status.compendium.folder) {
                            await assignCompendiumToFolder(status.compendium, compFolder);
                        }
                        status.compendium.render(true);
                        return;
                    }
                    const btn = ev.currentTarget;
                    btn.disabled = true;
                    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                    try {
                        const comp = await importPackAsCompendium(pack);
                        this.refreshGridOnly();
                        if (comp) comp.render(true);
                    } catch (err) {
                        ui.notifications.error(err.message);
                        btn.disabled = false;
                        btn.innerHTML = `<i class="fa-solid fa-file-import"></i> Importuj`;
                    }
                });

                tile.querySelector(".zmb-delete-pack")?.addEventListener("click", async () => {
                    const confirmed = await Dialog.confirm({
                        title: "Usuń Kompendium",
                        content: `<p>Czy na pewno chcesz usunąć kompendium <strong>${cleanTitle}</strong> ze świata?</p>`
                    });
                    if (confirmed) {
                        await deletePackCompendium(pack);
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

        this.backButton.style.display = "";
        this.catSelect.style.display = "none";
        this.gridContainer.innerHTML = "";

        const versionStr = pack.version ? `v${pack.version}` : "v1.0";
        const scenes = [];

        for (const sceneMeta of pack.scenes) {
            const sName = sceneMeta.name || "Scena";
            if (this.searchQuery && !sName.toLowerCase().includes(this.searchQuery)) continue;

            const worldScene = game.scenes.find(s =>
            s.getFlag(MODULE_ID, "moduleId") === pack.moduleId &&
            s.getFlag(MODULE_ID, "sceneId") === sceneMeta.id
            );
            const isImported = Boolean(worldScene);

            if (this.filterStatus === "imported" && !isImported) continue;
            if (this.filterStatus === "not-imported" && isImported) continue;

            scenes.push({ sceneMeta, worldScene, isImported });
        }

        this.countElement.textContent = `${pack.title} (${versionStr}) — Warianty: ${scenes.length}`;

        const fragment = document.createDocumentFragment();
        const imagesToQueue = [];

        for (const { sceneMeta, worldScene, isImported } of scenes) {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${isImported ? "is-imported" : ""}`;
            const thumbUrl = resolveAssetUrl(baseUrl, sceneMeta.thumb, pack.moduleId, true);
            const sceneName = sceneMeta.name || "Scena";

            tile.innerHTML = `
            <div class="zmb-thumb">
            <img data-src="${thumbUrl}" alt="${sceneName}" />
            <div class="zmb-meta-overlay">
            <span class="zmb-tag">${sceneMeta.width || "?"}×${sceneMeta.height || "?"}</span>
            <span class="zmb-tag">${versionStr}</span>
            </div>
            <div class="zmb-status-bar ${isImported ? "imported" : ""}">
            ${isImported ? "W świecie" : "Zdalna scena"}
            </div>
            </div>
            <div class="zmb-body">
            <div class="zmb-title" title="${sceneName}">${sceneName}</div>
            <div class="zmb-actions">
            <button type="button" class="zmb-import-scene" ${isImported ? "disabled" : ""}>
            <i class="fa-solid fa-download"></i> ${isImported ? "W świecie" : "Do świata"}
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
                    btn.innerHTML = `<i class="fa-solid fa-download"></i> Do świata`;
                }
            });

            tile.querySelector(".zmb-open-scene").addEventListener("click", async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                try {
                    const targetScene = await importSingleSceneToWorld(pack, sceneMeta);
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
