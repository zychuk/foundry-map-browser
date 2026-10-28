const MODULE_ID = "zychu-map-browser";
const ROOT_SCENE_FOLDER = "Zychu Maps";

let catalogCache = null;
let browserInstance = null;

const createdDirsCache = new Set();
const uploadedAssetsCache = new Map();

const naturalCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base"
});

/* -------------------------------------------- */
/*  Inicjalizacja i ustawienia                  */
/* -------------------------------------------- */

function resetCachesOnUrlChange() {
    catalogCache = null;
    uploadedAssetsCache.clear();
    if (browserInstance?.rendered) browserInstance.render();
}

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "serverUrl", {
        name: "Adres URL serwera map",
        hint: "Główny adres serwera z plikiem catalog.json (np. https://maps.zychu.org). Bez ukośnika na końcu.",
                           scope: "world",
                           config: true,
                           type: String,
                           default: "",
                               onChange: resetCachesOnUrlChange
    });

    game.settings.register(MODULE_ID, "localServerUrl", {
        name: "Lokalny / alternatywny URL serwera (opcjonalnie)",
                           hint: "Ustawienie tylko dla Twojej przeglądarki. Pozostaw puste, aby używać głównego adresu świata.",
                           scope: "client",
                           config: true,
                           type: String,
                           default: "",
                               onChange: resetCachesOnUrlChange
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
/*  Funkcje pomocnicze i budowanie URL          */
/* -------------------------------------------- */

function getServerUrl() {
    const localOverride = (game.settings.get(MODULE_ID, "localServerUrl") || "").trim().replace(/\/+$/, "");
    if (localOverride) return localOverride;
    const raw = game.settings.get(MODULE_ID, "serverUrl") || "";
    return raw.trim().replace(/\/+$/, "");
}

function getCleanPackTitle(pack) {
    return (pack.title || pack.moduleId || "")
    .replace(/^(Cze and Peku\s*-\s*|Czepeku Scenes\s*-\s*|Czepeku\s*-\s*)/i, "")
    .trim();
}

function getSortKey(pack) {
    return getCleanPackTitle(pack)
    .replace(/^\d+\s*[-–.]*\s*/, "")
    .trim();
}

function buildRemoteUrl(baseUrl, relativePath) {
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
        try {
            return encodeURIComponent(decodeURIComponent(segment));
        } catch {
            return encodeURIComponent(segment);
        }
    })
    .join("/");
    return `${baseUrl}/${encoded}`;
}

function resolveAssetUrl(baseUrl, assetPath, moduleId) {
    if (!assetPath || typeof assetPath !== "string") return "";
    const trimmed = assetPath.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
        return trimmed;
    }
    if (trimmed.startsWith("icons/") || trimmed.startsWith("ui/")) {
        return trimmed;
    }

    const clean = trimmed.replace(/^\/+/, "");
    if (clean.startsWith("thumbs/")) {
        return buildRemoteUrl(baseUrl, clean);
    }
    if (clean.startsWith("modules/")) {
        const parts = clean.split("/");
        if (moduleId && parts.length > 2) {
            parts[1] = moduleId;
        }
        return buildRemoteUrl(baseUrl, parts.join("/"));
    }
    return buildRemoteUrl(baseUrl, `modules/${moduleId}/${clean}`);
}

/**
 * Dynamicznie zlicza liczbę scen w module w czasie działania (sceneCount z JSON-a jest tylko fallbackiem)
 */
function getPackTotalCount(pack) {
    if (Array.isArray(pack.scenes)) {
        return pack.scenes.length;
    }
    return Number(pack.sceneCount) || 0;
}

/**
 * Zwraca uporządkowaną listę kandydatów URL na miniaturkę katalogu:
 * 1. Jawnie podana ścieżka pack.cover w catalog.json ma pierwszeństwo.
 * 2. Fallback: kolejne pliki miniaturek (lub teł) ze scen wewnątrz modułu.
 */
function getPackCoverCandidates(baseUrl, pack) {
    const candidates = [];
    const seen = new Set();

    const addCandidate = (relPath) => {
        if (!relPath) return;
        const url = resolveAssetUrl(baseUrl, relPath, pack.moduleId);
        if (url && !seen.has(url)) {
            seen.add(url);
            candidates.push(url);
        }
    };

    if (pack.cover) {
        addCandidate(pack.cover);
    }

    if (Array.isArray(pack.scenes)) {
        for (const s of pack.scenes) {
            addCandidate(s.thumb);
            addCandidate(s.bg);
        }
    }

    return candidates;
}

/**
 * Zwraca główny URL miniatury pojedynczej sceny oraz listę zapasową (np. pełny obraz tła)
 */
function getSceneThumbCandidates(baseUrl, pack, sceneMeta) {
    const candidates = [];
    if (sceneMeta.thumb) {
        const thumbUrl = resolveAssetUrl(baseUrl, sceneMeta.thumb, pack.moduleId);
        if (thumbUrl) candidates.push(thumbUrl);
    }
    if (sceneMeta.bg) {
        const bgUrl = resolveAssetUrl(baseUrl, sceneMeta.bg, pack.moduleId);
        if (bgUrl && !candidates.includes(bgUrl)) candidates.push(bgUrl);
    }
    return candidates;
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
/*  Pobieranie plików do folderu świata         */
/* -------------------------------------------- */

async function ensureWorldDirectory(targetDir) {
    if (createdDirsCache.has(targetDir)) return;

    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
    const parts = targetDir.split("/").filter(Boolean);

    let current = parts.slice(0, 2).join("/");
    for (let i = 2; i < parts.length; i++) {
        current = `${current}/${parts[i]}`;
        if (createdDirsCache.has(current)) continue;
        try {
            await FP.createDirectory("data", current);
        } catch {
            // Folder już istnieje
        }
        createdDirsCache.add(current);
    }
}

async function downloadAssetToWorld(baseUrl, assetPath, moduleId, subFolderHint = "maps") {
    if (!assetPath || typeof assetPath !== "string") return "";
    const trimmed = assetPath.trim();
    if (!trimmed || trimmed.startsWith("icons/") || trimmed.startsWith("ui/") || trimmed.startsWith("worlds/")) {
        return trimmed;
    }

    const remoteUrl = resolveAssetUrl(baseUrl, trimmed, moduleId);
    if (!remoteUrl) return "";

    const cacheKey = `${game.world.id}:${remoteUrl}`;
    if (uploadedAssetsCache.has(cacheKey)) {
        return uploadedAssetsCache.get(cacheKey);
    }

    const rawFileName = trimmed.split("/").pop() || "asset.webp";
    let decodedFileName = rawFileName;
    try {
        decodedFileName = decodeURIComponent(rawFileName);
    } catch {
        // Zostaw oryginał
    }

    const cleanFileName = decodedFileName.replace(/\s+/g, "_");
    const safeModuleDir = moduleId.replace(/[^a-zA-Z0-9-_]/g, "_");
    const targetDir = `worlds/${game.world.id}/zychu-maps/${safeModuleDir}/${subFolderHint}`;

    await ensureWorldDirectory(targetDir);

    const response = await fetch(remoteUrl);
    if (!response.ok) {
        throw new Error(`Nie udało się pobrać pliku (${response.status}): ${remoteUrl}`);
    }

    const blob = await response.blob();
    const file = new File([blob], cleanFileName, { type: blob.type || "application/octet-stream" });

    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
    const uploadRes = await FP.upload("data", targetDir, file, {}, { notify: false });

    const savedPath = uploadRes?.path || `${targetDir}/${cleanFileName}`;
    uploadedAssetsCache.set(cacheKey, savedPath);
    return savedPath;
}

/* -------------------------------------------- */
/*  Indeksowanie i Hierarchia Folderów Scen     */
/* -------------------------------------------- */

function buildWorldSceneIndex() {
    const byKey = new Map();
    for (const s of game.scenes) {
        const flagMod = s.getFlag(MODULE_ID, "moduleId");
        const flagScene = s.getFlag(MODULE_ID, "sceneId");
        if (flagMod && flagScene) {
            byKey.set(`${flagMod}:${flagScene}`, s);
        }
    }
    return byKey;
}

function findWorldScene(worldIndex, moduleId, sceneId) {
    return worldIndex.get(`${moduleId}:${sceneId}`);
}

function getPackStatus(pack, worldIndex) {
    const scenes = Array.isArray(pack.scenes) ? pack.scenes : [];
    let importedCount = 0;

    for (const s of scenes) {
        if (findWorldScene(worldIndex, pack.moduleId, s.id)) {
            importedCount++;
        }
    }

    const totalCount = getPackTotalCount(pack);
    return {
        importedCount,
        totalCount,
        isImported: importedCount > 0,
        isFullyImported: totalCount > 0 && importedCount >= totalCount
    };
}

async function getOrCreateSceneFolder(pack) {
    let rootFolder = game.folders.find(
        f => f.type === "Scene" && !f.folder && (f.getFlag(MODULE_ID, "isRoot") || f.name === ROOT_SCENE_FOLDER)
    );

    if (!rootFolder) {
        rootFolder = await Folder.create({
            name: ROOT_SCENE_FOLDER,
            type: "Scene",
            folder: null,
            color: "#2e5a44",
            flags: {
                [MODULE_ID]: { isRoot: true }
            }
        });
    }

    const cleanName = getCleanPackTitle(pack);
    let packFolder = game.folders.find(
        f => f.type === "Scene" &&
        f.id !== rootFolder.id &&
        (f.getFlag(MODULE_ID, "moduleId") === pack.moduleId ||
        (f.name === cleanName && f.folder?.id === rootFolder.id))
    );

    if (!packFolder) {
        packFolder = await Folder.create({
            name: cleanName,
            type: "Scene",
            folder: rootFolder.id,
            flags: {
                [MODULE_ID]: {
                    moduleId: pack.moduleId,
                    version: pack.version || "1.0.0"
                }
            }
        });
    } else if (packFolder.folder?.id !== rootFolder.id) {
        await packFolder.update({ folder: rootFolder.id });
    }

    return packFolder;
}

/* -------------------------------------------- */
/*  Konwersja i naprawa danych Sceny            */
/* -------------------------------------------- */

function ensureValidId(id) {
    if (typeof id === "string" && /^[a-zA-Z0-9]{16}$/.test(id)) return id;
    return foundry.utils.randomID();
}

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
        wall._id = ensureValidId(wall._id);

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

async function prepareSceneDataWithLocalAssets(raw, pack, meta, folderId, baseUrl) {
    const originalId = raw._id;
    const prepared = foundry.utils.deepClone(raw);
    delete prepared._id;

    const rawBgPath =
    meta?.bg ||
    raw.background?.src ||
    raw.img ||
    null;

    let localBgPath = null;
    if (rawBgPath) {
        localBgPath = await downloadAssetToWorld(baseUrl, rawBgPath, pack.moduleId, "maps");
    }

    const rawThumbPath = meta?.thumb || raw.thumb || null;
    let localThumbPath = localBgPath;
    if (rawThumbPath) {
        try {
            localThumbPath = await downloadAssetToWorld(baseUrl, rawThumbPath, pack.moduleId, "thumbs");
        } catch {
            localThumbPath = localBgPath;
        }
    }

    const bgColor =
    (typeof raw.backgroundColor === "string" && raw.backgroundColor) ||
    (typeof raw.bgColor === "string" && raw.bgColor) ||
    "#000000";

    if (!prepared.width && meta?.width) prepared.width = Number(meta.width);
    if (!prepared.height && meta?.height) prepared.height = Number(meta.height);

    if (typeof prepared.grid === "number" || !prepared.grid) {
        const gridSize = typeof prepared.grid === "number" ? prepared.grid : 100;
        prepared.grid = {
            size: gridSize || 100,
            type: prepared.gridType ?? 1,
            distance: prepared.gridDistance ?? 5,
            units: prepared.gridUnits || "ft",
            color: prepared.gridColor || "#000000",
            alpha: prepared.gridAlpha ?? 0.2
        };
        delete prepared.gridType;
        delete prepared.gridDistance;
        delete prepared.gridUnits;
        delete prepared.gridColor;
        delete prepared.gridAlpha;
    }

    if (Array.isArray(prepared.walls)) {
        prepared.walls = normalizeLegacyWalls(prepared.walls);
    }

    if (Array.isArray(prepared.tiles)) {
        for (const tile of prepared.tiles) {
            tile._id = ensureValidId(tile._id);
            const tileSrc = tile.texture?.src || tile.img;
            if (tileSrc) {
                try {
                    const localTilePath = await downloadAssetToWorld(baseUrl, tileSrc, pack.moduleId, "tiles");
                    tile.texture = foundry.utils.mergeObject(tile.texture || {}, { src: localTilePath });
                } catch {
                    tile.texture = foundry.utils.mergeObject(tile.texture || {}, {
                        src: resolveAssetUrl(baseUrl, tileSrc, pack.moduleId)
                    });
                }
            }
            delete tile.img;
        }
    }

    if (typeof prepared.foreground === "string" && prepared.foreground) {
        try {
            prepared.foreground = await downloadAssetToWorld(baseUrl, prepared.foreground, pack.moduleId, "tiles");
        } catch {
            delete prepared.foreground;
        }
    }

    for (const key of ["lights", "sounds", "templates", "tokens", "notes", "drawings"]) {
        if (Array.isArray(prepared[key])) {
            for (const item of prepared[key]) {
                item._id = ensureValidId(item._id);
            }
        }
    }

    delete prepared.img;
    delete prepared.bgColor;
    prepared.backgroundColor = bgColor;
    prepared.background = foundry.utils.mergeObject(
        typeof prepared.background === "object" && prepared.background ? prepared.background : {},
        { src: localBgPath }
    );

    try {
        if (typeof Scene.migrateData === "function") {
            const migrated = Scene.migrateData(prepared);
            Object.assign(prepared, migrated);
        }
    } catch (err) {
        console.warn(`[${MODULE_ID}] Scene.migrateData warning:`, err);
    }

    if (localBgPath) {
        prepared.background = foundry.utils.mergeObject(
            typeof prepared.background === "object" && prepared.background ? prepared.background : {},
            { src: localBgPath }
        );

        if (Array.isArray(prepared.levels) && prepared.levels.length > 0) {
            for (const lvl of prepared.levels) {
                lvl._id = ensureValidId(lvl._id);
                if (!lvl.name) lvl.name = "Initial Level";
                lvl.background = foundry.utils.mergeObject(
                    typeof lvl.background === "object" && lvl.background ? lvl.background : {},
                    { src: localBgPath, color: bgColor }
                );
            }
        } else if (Scene.schema?.fields?.levels) {
            const levelId = foundry.utils.randomID();
            prepared.levels = [
                {
                    _id: levelId,
                    name: "Initial Level",
                    background: {
                        src: localBgPath,
                        color: bgColor
                    }
                }
            ];
            if ("initialLevel" in Scene.schema.fields) {
                prepared.initialLevel = levelId;
            }
        }
    }

    prepared.folder = folderId;
    if (localThumbPath) {
        prepared.thumb = localThumbPath;
    }

    prepared.flags = foundry.utils.mergeObject(prepared.flags || {}, {
        [MODULE_ID]: {
            moduleId: pack.moduleId,
            sceneId: originalId,
            version: pack.version || "1.0.0",
            bgPath: localBgPath
        }
    });

    return prepared;
}

async function ensureCreatedScenesHaveLevelBg(createdDocs) {
    if (!Array.isArray(createdDocs)) return;
    for (const sceneDoc of createdDocs) {
        const expectedBg = sceneDoc.getFlag(MODULE_ID, "bgPath");
        if (!expectedBg) continue;

        const firstLevel = sceneDoc.levels?.contents?.[0];
        if (firstLevel && firstLevel.background?.src !== expectedBg) {
            try {
                await firstLevel.update({ "background.src": expectedBg });
            } catch (err) {
                console.warn(`[${MODULE_ID}] Nie udało się zaktualizować tła poziomu:`, err);
            }
        }
    }
}

/* -------------------------------------------- */
/*  Akcje Importu do Świata                     */
/* -------------------------------------------- */

async function importPackToWorld(pack, onProgress = null) {
    const baseUrl = getServerUrl();
    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(pack.moduleId)}/scenes.json`;

    const res = await fetch(scenesUrl);
    if (!res.ok) throw new Error(`Nie udało się pobrać pliku scenes.json (HTTP ${res.status})`);

    const rawScenes = await res.json();
    const worldIndex = buildWorldSceneIndex();
    const packScenes = Array.isArray(pack.scenes) ? pack.scenes : [];

    const missingItems = [];
    for (let i = 0; i < rawScenes.length; i++) {
        const raw = rawScenes[i];
        const meta =
        packScenes.find(s => s.id === raw._id) ||
        packScenes.find(s => s.name === raw.name);

        if (!meta) continue;

        const sceneId = meta.id || raw._id;
        if (findWorldScene(worldIndex, pack.moduleId, sceneId)) continue;
        missingItems.push({ raw, meta });
    }

    if (missingItems.length === 0) {
        ui.notifications.info(`Wszystkie sceny z paczki "${getCleanPackTitle(pack)}" są już w świecie.`);
        return;
    }

    const folder = await getOrCreateSceneFolder(pack);
    const toCreate = [];
    let skippedCount = 0;

    for (let i = 0; i < missingItems.length; i++) {
        if (onProgress) onProgress(i + 1, missingItems.length);
        const { raw, meta } = missingItems[i];
        try {
            const prepared = await prepareSceneDataWithLocalAssets(raw, pack, meta, folder.id, baseUrl);
            toCreate.push(prepared);
        } catch (err) {
            skippedCount++;
            console.warn(`[${MODULE_ID}] Pominięto uszkodzoną scenę "${meta?.name || raw.name}":`, err);
        }
    }

    if (toCreate.length === 0) {
        throw new Error(`Nie udało się pobrać żadnej sceny z paczki "${getCleanPackTitle(pack)}".`);
    }

    if (browserInstance) browserInstance.isBulkImporting = true;
    let createdDocs = [];
    try {
        createdDocs = await Scene.createDocuments(toCreate);
        await ensureCreatedScenesHaveLevelBg(createdDocs);
    } finally {
        if (browserInstance) browserInstance.isBulkImporting = false;
    }

    if (skippedCount > 0) {
        ui.notifications.warn(
            `Zaimportowano ${createdDocs?.length || toCreate.length} scen z "${getCleanPackTitle(pack)}" (pominięto ${skippedCount} brakujących plików na serwerze).`
        );
    } else {
        ui.notifications.info(`Zaimportowano ${createdDocs?.length || toCreate.length} scen do Zychu Maps / ${getCleanPackTitle(pack)}.`);
    }
}

async function importSingleSceneToWorld(pack, sceneMeta) {
    const worldIndex = buildWorldSceneIndex();
    const existing = findWorldScene(worldIndex, pack.moduleId, sceneMeta.id);
    if (existing) return existing;

    const baseUrl = getServerUrl();
    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(pack.moduleId)}/scenes.json`;

    const res = await fetch(scenesUrl);
    if (!res.ok) throw new Error(`Nie udało się pobrać pliku scenes.json (HTTP ${res.status})`);

    const rawScenes = await res.json();
    const raw =
    rawScenes.find(s => s._id === sceneMeta.id) ||
    rawScenes.find(s => s.name === sceneMeta.name);
    if (!raw) throw new Error("Nie znaleziono wybranej sceny w pliku scenes.json.");

    const folder = await getOrCreateSceneFolder(pack);
    const prepared = await prepareSceneDataWithLocalAssets(raw, pack, sceneMeta, folder.id, baseUrl);

    const created = await Scene.create(prepared);
    if (!created) {
        throw new Error(`Nie udało się utworzyć sceny "${sceneMeta.name}".`);
    }

    await ensureCreatedScenesHaveLevelBg([created]);
    ui.notifications.info(`Zaimportowano scenę: ${created.name}`);
    return created;
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
            if (gen !== this.generation || !img.isConnected) {
                finish();
                return;
            }

            // Jeśli główna miniaturka (np. pack.cover) nie istnieje, wypróbuj pierwszy dostępny plik z listy zapasowej
            if (Array.isArray(img._fallbacks) && img._fallbacks.length > 0) {
                const nextUrl = img._fallbacks.shift();
                img.src = nextUrl;
                return;
            }

            img.onload = null;
            img.onerror = null;
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
        const worldIndex = buildWorldSceneIndex();

        this.backButton.style.display = "none";
        this.catSelect.style.display = "";
        this.gridContainer.innerHTML = "";

        const packs = catalogCache.packs || [];
        const filtered = [];

        for (const pack of packs) {
            if (this.filterCategory !== "all" && pack.category !== this.filterCategory) continue;

            const cleanTitle = getCleanPackTitle(pack);
            const sortKey = getSortKey(pack);
            const packScenes = Array.isArray(pack.scenes) ? pack.scenes : [];

            if (this.searchQuery) {
                const matchTitle = cleanTitle.toLowerCase().includes(this.searchQuery) ||
                (pack.title || "").toLowerCase().includes(this.searchQuery);
                const matchId = (pack.moduleId || "").toLowerCase().includes(this.searchQuery);
                const matchScene = packScenes.some(s => (s.name || "").toLowerCase().includes(this.searchQuery));
                if (!matchTitle && !matchId && !matchScene) continue;
            }

            const status = getPackStatus(pack, worldIndex);
            if (this.filterStatus === "imported" && !status.isImported) continue;
            if (this.filterStatus === "not-imported" && status.isImported) continue;

            filtered.push({ pack, status, cleanTitle, sortKey });
        }

        filtered.sort((a, b) => {
            const cmp = naturalCollator.compare(a.sortKey, b.sortKey);
            if (cmp !== 0) return cmp;
            return naturalCollator.compare(a.cleanTitle, b.cleanTitle);
        });

        this.countElement.textContent = `Wyświetlono: ${filtered.length} / ${packs.length}`;

        if (filtered.length === 0) {
            this.gridContainer.innerHTML = `<div class="zmb-empty" style="grid-column: 1 / -1;">Brak wyników spełniających kryteria filtrów.</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();
        const imagesToQueue = [];

        for (const { pack, status, cleanTitle } of filtered) {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${status.isImported ? "is-imported" : ""}`;

            const versionStr = pack.version ? `v${pack.version}` : "v1.0";
            const coverCandidates = getPackCoverCandidates(baseUrl, pack);
            const primaryThumbUrl = coverCandidates[0] || "icons/svg/adastra.svg";

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
            <img data-src="${primaryThumbUrl}" alt="${cleanTitle}" />
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
            <i class="fa-solid ${status.isFullyImported ? "fa-check" : "fa-file-import"}"></i>
            ${status.isFullyImported ? "W świecie" : "Importuj"}
            </button>
            <button type="button" class="zmb-view-scenes" title="Pokaż pojedyncze warianty">
            <i class="fa-solid fa-folder-open"></i> Sceny
            </button>
            </div>
            </div>
            `;

            const imgEl = tile.querySelector("img");
            imgEl._fallbacks = coverCandidates.slice(1);
            imagesToQueue.push(imgEl);

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
                    await importPackToWorld(pack, (current, total) => {
                        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${current}/${total}`;
                    });
                    this.refreshGridOnly();
                } catch (err) {
                    ui.notifications.error(err.message);
                    btn.disabled = false;
                    btn.innerHTML = `<i class="fa-solid fa-file-import"></i> Importuj`;
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

        const cleanTitle = getCleanPackTitle(pack);
        const versionStr = pack.version ? `v${pack.version}` : "v1.0";
        const packScenes = Array.isArray(pack.scenes) ? pack.scenes : [];
        const scenes = [];

        for (const sceneMeta of packScenes) {
            const sName = sceneMeta.name || "Scena";
            if (this.searchQuery && !sName.toLowerCase().includes(this.searchQuery)) continue;

            const worldScene = findWorldScene(worldIndex, pack.moduleId, sceneMeta.id);
            const isImported = Boolean(worldScene);

            if (this.filterStatus === "imported" && !isImported) continue;
            if (this.filterStatus === "not-imported" && isImported) continue;

            scenes.push({ sceneMeta, worldScene, isImported });
        }

        scenes.sort((a, b) => naturalCollator.compare(a.sceneMeta.name || "", b.sceneMeta.name || ""));

        this.countElement.textContent = `${cleanTitle} (${versionStr}) — Sceny: ${scenes.length} / ${getPackTotalCount(pack)}`;

        const fragment = document.createDocumentFragment();
        const imagesToQueue = [];

        for (const { sceneMeta, worldScene, isImported } of scenes) {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${isImported ? "is-imported" : ""}`;
            const thumbCandidates = getSceneThumbCandidates(baseUrl, pack, sceneMeta);
            const primaryThumbUrl = thumbCandidates[0] || "icons/svg/adastra.svg";
            const sceneName = sceneMeta.name || "Scena";

            tile.innerHTML = `
            <div class="zmb-thumb">
            <img data-src="${primaryThumbUrl}" alt="${sceneName}" />
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
            <i class="fa-solid ${isImported ? "fa-check" : "fa-download"}"></i>
            ${isImported ? "W świecie" : "Importuj"}
            </button>
            <button type="button" class="zmb-open-scene">
            <i class="fa-solid fa-eye"></i> Otwórz
            </button>
            </div>
            </div>
            `;

            const imgEl = tile.querySelector("img");
            imgEl._fallbacks = thumbCandidates.slice(1);
            imagesToQueue.push(imgEl);

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
