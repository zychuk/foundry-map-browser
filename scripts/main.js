const MODULE_ID = "zychu-map-browser";
const ROOT_SCENE_FOLDER = "Zychu Maps";
const FALLBACK_THUMB = "icons/svg/direction.svg";

let catalogCache = null;
let browserInstance = null;

const scenesJsonCache = new Map();
const dirEnsurePromises = new Map();
const existingWorldFilesCache = new Set();
const uploadedAssetsCache = new Map();

const naturalCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base"
});

/* -------------------------------------------- */
/*  Inicjalizacja i ustawienia                  */
/* -------------------------------------------- */

function clearAllCaches() {
    catalogCache = null;
    scenesJsonCache.clear();
    dirEnsurePromises.clear();
    existingWorldFilesCache.clear();
    uploadedAssetsCache.clear();
}

function resetCachesOnUrlChange() {
    clearAllCaches();
    if (browserInstance?.rendered) browserInstance.render();
}

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "serverUrl", {
        name: "ZMB.ServerUrlName",
        hint: "ZMB.ServerUrlHint",
        scope: "world",
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
    btn.innerHTML = `<i class="fa-solid fa-map"></i> ${game.i18n.localize("ZMB.OpenBrowser")}`;
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

Hooks.on("createScene", (scene) => {
    if (!scene?.getFlag?.(MODULE_ID, "moduleId")) return;
    if (browserInstance?.rendered && !browserInstance.isBulkImporting) {
        browserInstance.refreshGridOnly({ preserveScroll: true });
    }
});

Hooks.on("deleteScene", (scene) => {
    if (!scene?.getFlag?.(MODULE_ID, "moduleId")) return;
    if (browserInstance?.rendered && !browserInstance.isBulkImporting) {
        browserInstance.refreshGridOnly({ preserveScroll: true });
    }
});

/* -------------------------------------------- */
/*  Funkcje pomocnicze i współbieżność          */
/* -------------------------------------------- */

async function mapWithConcurrency(items, concurrency, iteratorFn) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const results = new Array(items.length);
    let nextIndex = 0;

    const worker = async () => {
        while (nextIndex < items.length) {
            const current = nextIndex++;
            results[current] = await iteratorFn(items[current], current);
        }
    };

    const workersCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workersCount }, () => worker()));
    return results;
}

function openImagePreview(src, title) {
    if (!src) return;
    const AppV2Popout = foundry.applications?.apps?.ImagePopout;
    const AppV2Base = foundry.applications?.api?.ApplicationV2;
    if (AppV2Popout && AppV2Base && AppV2Popout.prototype instanceof AppV2Base) {
        new AppV2Popout({ src, window: { title } }).render({ force: true });
    } else if (typeof ImagePopout !== "undefined") {
        new ImagePopout(src, { title }).render(true);
    }
}

function getServerUrl() {
    const raw = game.settings.get(MODULE_ID, "serverUrl") || "";
    return raw.trim().replace(/\/+$/, "");
}

function getCleanPackTitle(pack) {
    if (pack._cleanTitle) return pack._cleanTitle;
    return (pack.title || pack.moduleId || "")
    .replace(/^(Cze and Peku\s*-\s*|Czepeku Scenes\s*-\s*|Czepeku\s*-\s*)/i, "")
    .trim();
}

function getSortKey(pack) {
    if (pack._sortKey) return pack._sortKey;
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

function getPackTotalCount(pack) {
    if (Array.isArray(pack.scenes)) {
        return pack.scenes.length;
    }
    return Number(pack.sceneCount) || 0;
}

function getPackCoverCandidates(baseUrl, pack) {
    const candidates = [];
    const seen = new Set();

    const addCandidate = (relPath) => {
        if (!relPath || candidates.length >= 5) return;
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
        for (const s of pack.scenes) addCandidate(s.thumb);
        for (const s of pack.scenes) addCandidate(s.bg);
    }

    return candidates;
}

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

function preprocessCatalog(catalog) {
    if (!catalog || !Array.isArray(catalog.packs)) return catalog;
    for (const pack of catalog.packs) {
        pack._cleanTitle = getCleanPackTitle(pack);
        pack._sortKey = getSortKey(pack);
        const sceneNames = Array.isArray(pack.scenes)
        ? pack.scenes.map(s => s.name || "").join(" ")
        : "";
        pack._searchBlob = `${pack._cleanTitle} ${pack.title || ""} ${pack.moduleId || ""} ${sceneNames}`.toLowerCase();
    }
    catalog.packs.sort((a, b) => {
        const cmp = naturalCollator.compare(a._sortKey, b._sortKey);
        if (cmp !== 0) return cmp;
        return naturalCollator.compare(a._cleanTitle, b._cleanTitle);
    });
    return catalog;
}

async function loadCatalog(force = false) {
    const baseUrl = getServerUrl();
    if (!baseUrl) return null;

    if (!catalogCache || force) {
        if (force) scenesJsonCache.clear();
        const response = await fetch(`${baseUrl}/catalog.json`, { cache: "no-cache" });
        if (!response.ok) {
            throw new Error(game.i18n.format("ZMB.CatalogError", { status: response.status }));
        }
        const rawCatalog = await response.json();
        catalogCache = preprocessCatalog(rawCatalog);
    }
    return catalogCache;
}

async function loadPackScenesJson(baseUrl, moduleId) {
    if (scenesJsonCache.has(moduleId)) {
        return scenesJsonCache.get(moduleId);
    }
    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(moduleId)}/scenes.json`;
    const res = await fetch(scenesUrl);
    if (!res.ok) {
        throw new Error(game.i18n.format("ZMB.CatalogError", { status: res.status }));
    }
    const rawScenes = await res.json();
    scenesJsonCache.set(moduleId, rawScenes);
    return rawScenes;
}

/* -------------------------------------------- */
/*  Pobieranie plików do folderu świata         */
/* -------------------------------------------- */

async function ensureWorldDirectory(targetDir) {
    if (dirEnsurePromises.has(targetDir)) {
        return dirEnsurePromises.get(targetDir);
    }

    const promise = (async () => {
        const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;

        try {
            const browsed = await FP.browse("data", targetDir);
            if (browsed?.files) {
                for (const f of browsed.files) {
                    try {
                        existingWorldFilesCache.add(decodeURIComponent(f));
                    } catch {
                        existingWorldFilesCache.add(f);
                    }
                }
            }
            return;
        } catch {
            // Katalog jeszcze nie istnieje – utwórz drzewo katalogów
        }

        const parts = targetDir.split("/").filter(Boolean);
        let current = parts.slice(0, 2).join("/");
        for (let i = 2; i < parts.length; i++) {
            current = `${current}/${parts[i]}`;
            if (dirEnsurePromises.has(current) && current !== targetDir) {
                await dirEnsurePromises.get(current);
                continue;
            }
            try {
                await FP.createDirectory("data", current);
            } catch {
                // Folder już istnieje
            }
            if (current !== targetDir) {
                dirEnsurePromises.set(current, Promise.resolve());
            }
        }
    })();

    dirEnsurePromises.set(targetDir, promise);
    try {
        await promise;
    } catch (err) {
        dirEnsurePromises.delete(targetDir);
        throw err;
    }
}

function buildLocalAssetFilename(trimmedPath) {
    let relInsideModule = trimmedPath.replace(/^\/+/, "");
    if (relInsideModule.startsWith("modules/")) {
        relInsideModule = relInsideModule.split("/").slice(2).join("/");
    }
    const relParts = relInsideModule.split("/").filter(Boolean).map(seg => {
        try {
            return decodeURIComponent(seg);
        } catch {
            return seg;
        }
    });

    if (relParts.length > 1 && ["maps", "_thumbs", "thumbs", "tiles", "tokens", "audio", "sounds"].includes(relParts[0].toLowerCase())) {
        relParts.shift();
    }

    const rawFileName = relParts.join("_") || "asset.webp";
    return rawFileName.replace(/\s+/g, "_");
}

async function downloadAssetToWorld(baseUrl, assetPath, moduleId, subFolderHint = "maps") {
    if (!assetPath || typeof assetPath !== "string") return "";
    const trimmed = assetPath.trim();
    if (!trimmed || trimmed.startsWith("icons/") || trimmed.startsWith("ui/") || trimmed.startsWith("worlds/")) {
        return trimmed;
    }

    const remoteUrl = resolveAssetUrl(baseUrl, trimmed, moduleId);
    if (!remoteUrl) return "";

    const cacheKey = `${game.world.id}:${subFolderHint}:${remoteUrl}`;
    if (uploadedAssetsCache.has(cacheKey)) {
        return uploadedAssetsCache.get(cacheKey);
    }

    const taskPromise = (async () => {
        const cleanFileName = buildLocalAssetFilename(trimmed);
        const safeModuleDir = moduleId.replace(/[^a-zA-Z0-9-_]/g, "_");
        const targetDir = `worlds/${game.world.id}/zychu-maps/${safeModuleDir}/${subFolderHint}`;
        const expectedLocalPath = `${targetDir}/${cleanFileName}`;

        await ensureWorldDirectory(targetDir);

        if (existingWorldFilesCache.has(expectedLocalPath)) {
            return expectedLocalPath;
        }

        const response = await fetch(remoteUrl);
        if (!response.ok) {
            throw new Error(game.i18n.format("ZMB.DownloadAssetError", { status: response.status, url: remoteUrl }));
        }

        const blob = await response.blob();
        const file = new File([blob], cleanFileName, { type: blob.type || "application/octet-stream" });

        const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
        const uploadRes = await FP.upload("data", targetDir, file, {}, { notify: false });

        const savedPath = uploadRes?.path || expectedLocalPath;
        existingWorldFilesCache.add(expectedLocalPath);
        return savedPath;
    })();

    uploadedAssetsCache.set(cacheKey, taskPromise);
    try {
        return await taskPromise;
    } catch (err) {
        uploadedAssetsCache.delete(cacheKey);
        throw err;
    }
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
        if (val === 3) return 30;
        if (val === 4) return 40;
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
    const originalId = raw._id || meta?.id;
    const prepared = foundry.utils.deepClone(raw);
    delete prepared._id;

    const rawBgPath =
    meta?.bg ||
    raw.background?.src ||
    raw.img ||
    raw.levels?.[0]?.background?.src ||
    null;

    const rawThumbPath = meta?.thumb || raw.thumb || null;

    // Pobierz tło i miniaturę równolegle
    const [localBgPath, downloadedThumbPath] = await Promise.all([
        rawBgPath ? downloadAssetToWorld(baseUrl, rawBgPath, pack.moduleId, "maps") : Promise.resolve(null),
                                                                 rawThumbPath
                                                                 ? downloadAssetToWorld(baseUrl, rawThumbPath, pack.moduleId, "thumbs").catch(() => null)
                                                                 : Promise.resolve(null)
    ]);
    const localThumbPath = downloadedThumbPath || localBgPath;

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
            await mapWithConcurrency(prepared.tiles, 4, async (tile) => {
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
            });
        }

        if (Array.isArray(prepared.tokens)) {
            await mapWithConcurrency(prepared.tokens, 4, async (token) => {
                token._id = ensureValidId(token._id);
                const tokSrc = token.texture?.src || token.img;
                if (tokSrc) {
                    try {
                        const localTokPath = await downloadAssetToWorld(baseUrl, tokSrc, pack.moduleId, "tokens");
                        token.texture = foundry.utils.mergeObject(token.texture || {}, { src: localTokPath });
                    } catch {
                        token.texture = foundry.utils.mergeObject(token.texture || {}, {
                            src: resolveAssetUrl(baseUrl, tokSrc, pack.moduleId)
                        });
                    }
                }
                delete token.img;
            });
        }

        if (Array.isArray(prepared.sounds)) {
            await mapWithConcurrency(prepared.sounds, 4, async (sound) => {
                sound._id = ensureValidId(sound._id);
                if (sound.path) {
                    try {
                        sound.path = await downloadAssetToWorld(baseUrl, sound.path, pack.moduleId, "audio");
                    } catch {
                        sound.path = resolveAssetUrl(baseUrl, sound.path, pack.moduleId);
                    }
                }
            });
        }

        if (typeof prepared.foreground === "string" && prepared.foreground) {
            try {
                prepared.foreground = await downloadAssetToWorld(baseUrl, prepared.foreground, pack.moduleId, "tiles");
            } catch {
                delete prepared.foreground;
            }
        }

        for (const key of ["lights", "templates", "notes", "drawings"]) {
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
                for (let i = 0; i < prepared.levels.length; i++) {
                    const lvl = prepared.levels[i];
                    const oldId = lvl._id;
                    lvl._id = ensureValidId(lvl._id);
                    if (prepared.initialLevel === oldId) prepared.initialLevel = lvl._id;
                    if (!lvl.name) lvl.name = i === 0 ? "Initial Level" : `Level ${i + 1}`;

                    let lvlBg = localBgPath;
                    if (lvl.background?.src && lvl.background.src !== rawBgPath && !lvl.background.src.startsWith("worlds/")) {
                        try {
                            lvlBg = await downloadAssetToWorld(baseUrl, lvl.background.src, pack.moduleId, "maps");
                        } catch {
                            lvlBg = localBgPath;
                        }
                    } else if (lvl.background?.src?.startsWith("worlds/")) {
                        lvlBg = lvl.background.src;
                    }

                    if (i === 0 || lvl.background?.src) {
                        lvl.background = foundry.utils.mergeObject(
                            typeof lvl.background === "object" && lvl.background ? lvl.background : {},
                            { src: lvlBg, color: bgColor }
                        );
                    }
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
                console.warn(`[${MODULE_ID}] Failed to update level background:`, err);
            }
        }
    }
}

/* -------------------------------------------- */
/*  Akcje Importu do Świata                     */
/* -------------------------------------------- */

async function importPackToWorld(pack, onProgress = null) {
    const baseUrl = getServerUrl();
    const rawScenes = await loadPackScenesJson(baseUrl, pack.moduleId);
    const worldIndex = buildWorldSceneIndex();
    const packScenes = Array.isArray(pack.scenes) ? pack.scenes : [];

    const missingItems = [];
    for (let i = 0; i < rawScenes.length; i++) {
        const raw = rawScenes[i];
        const meta =
        packScenes.find(s => s.id === raw._id) ||
        packScenes.find(s => s.name === raw.name) ||
        {
            id: raw._id,
            name: raw.name,
            width: raw.width,
            height: raw.height,
            thumb: raw.thumb,
            bg: raw.background?.src || raw.img
        };

        const sceneId = meta.id || raw._id;
        if (!sceneId || findWorldScene(worldIndex, pack.moduleId, sceneId)) continue;
        missingItems.push({ raw, meta });
    }

    const packTitle = getCleanPackTitle(pack);
    if (missingItems.length === 0) {
        ui.notifications.info(game.i18n.format("ZMB.AllScenesImported", { title: packTitle }));
        return;
    }

    const folder = await getOrCreateSceneFolder(pack);
    let skippedCount = 0;
    let completedCount = 0;

    if (onProgress) onProgress(0, missingItems.length);

    const preparedResults = await mapWithConcurrency(missingItems, 2, async ({ raw, meta }) => {
        try {
            const prepared = await prepareSceneDataWithLocalAssets(raw, pack, meta, folder.id, baseUrl);
            return prepared;
        } catch (err) {
            skippedCount++;
            console.warn(`[${MODULE_ID}] Skipped broken scene "${meta?.name || raw.name}":`, err);
            return null;
        } finally {
            completedCount++;
            if (onProgress) onProgress(completedCount, missingItems.length);
        }
    });

    const toCreate = preparedResults.filter(Boolean);

    if (toCreate.length === 0) {
        throw new Error(game.i18n.format("ZMB.PackImportAllFailed", { title: packTitle }));
    }

    if (browserInstance) browserInstance.isBulkImporting = true;
    let createdDocs = [];
    try {
        createdDocs = await Scene.createDocuments(toCreate);
        await ensureCreatedScenesHaveLevelBg(createdDocs);
    } finally {
        if (browserInstance) browserInstance.isBulkImporting = false;
    }

    const createdCount = createdDocs?.length || toCreate.length;
    if (skippedCount > 0) {
        ui.notifications.warn(game.i18n.format("ZMB.PackImportedWarn", { count: createdCount, title: packTitle, skipped: skippedCount }));
    } else {
        ui.notifications.info(game.i18n.format("ZMB.PackImportedInfo", { count: createdCount, title: packTitle }));
    }
}

async function importSingleSceneToWorld(pack, sceneMeta) {
    const worldIndex = buildWorldSceneIndex();
    const existing = findWorldScene(worldIndex, pack.moduleId, sceneMeta.id);
    if (existing) return existing;

    const baseUrl = getServerUrl();
    const rawScenes = await loadPackScenesJson(baseUrl, pack.moduleId);
    const raw =
    rawScenes.find(s => s._id === sceneMeta.id) ||
    rawScenes.find(s => s.name === sceneMeta.name);
    if (!raw) throw new Error(game.i18n.localize("ZMB.SceneNotFoundInJson"));

    const folder = await getOrCreateSceneFolder(pack);
    const prepared = await prepareSceneDataWithLocalAssets(raw, pack, sceneMeta, folder.id, baseUrl);

    if (browserInstance) browserInstance.isBulkImporting = true;
    let created = null;
    try {
        created = await Scene.create(prepared);
        if (!created) {
            throw new Error(game.i18n.format("ZMB.SceneCreateError", { name: sceneMeta.name }));
        }
        await ensureCreatedScenesHaveLevelBg([created]);
    } finally {
        if (browserInstance) browserInstance.isBulkImporting = false;
    }

    ui.notifications.info(game.i18n.format("ZMB.SceneImportedInfo", { name: created.name }));
    return created;
}

/* -------------------------------------------- */
/*  Kolejka asynchronicznego ładowania miniatur */
/* -------------------------------------------- */

class ThumbnailQueue {
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
        if (this.observer) {
            this.observer.disconnect();
        }

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
            {
                root: scrollRoot,
                rootMargin: "250px 0px"
            }
        );
    }

    observe(imgElement) {
        if (this.observer) {
            this.observer.observe(imgElement);
        } else {
            this.enqueue(imgElement, false);
        }
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
            img.parentElement?.classList.add("is-loaded");
            finish();
        };
        img.onerror = () => {
            if (gen !== this.generation || !img.isConnected) {
                finish();
                return;
            }

            if (Array.isArray(img._fallbacks) && img._fallbacks.length > 0) {
                const nextUrl = img._fallbacks.shift();
                img.src = nextUrl;
                return;
            }

            img.onload = null;
            img.onerror = null;
            img.src = FALLBACK_THUMB;
            img.classList.add("is-loaded");
            img.parentElement?.classList.add("is-loaded");
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
        this.savedPackSearch = "";
        this.savedPackScrollTop = 0;
        this.selectedPack = null;
        this.gridContainer = null;
        this.countElement = null;
        this.searchInput = null;
        this.packImportHeaderBtn = null;
        this.thumbQueue = new ThumbnailQueue(4);
        this.searchTimeout = null;
        this.isBulkImporting = false;
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
        position: {
            width: 980,
            height: 720
        }
    };

    /** @override */
    get title() {
        return game.i18n.localize("ZMB.WindowMainTitle");
    }

    /** @override */
    _onClose(options) {
        super._onClose?.(options);
        clearTimeout(this.searchTimeout);
        this.thumbQueue.reset(null);
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
            </div>
            `;
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
            </div>
            `;
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
        <div class="zmb-grid"></div>
        `;

        this.gridContainer = wrapper.querySelector(".zmb-grid");
        this.countElement = wrapper.querySelector(".zmb-count");
        this.backButton = wrapper.querySelector(".zmb-back-btn");
        this.catSelect = wrapper.querySelector(".zmb-cat-filter");
        this.searchInput = wrapper.querySelector(".zmb-search");
        this.packImportHeaderBtn = wrapper.querySelector(".zmb-pack-import-header-btn");

        this._bindToolbarEvents(wrapper);
        this.refreshGridOnly();
        return wrapper;
    }

    _replaceHTML(result, content) {
        content.replaceChildren(result);
    }

    _bindToolbarEvents(wrapper) {
        const statusSelect = wrapper.querySelector(".zmb-status-filter");
        const catSelect = wrapper.querySelector(".zmb-cat-filter");
        const refreshBtn = wrapper.querySelector(".zmb-refresh-btn");
        const backBtn = wrapper.querySelector(".zmb-back-btn");

        wrapper.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape" && this.selectedPack && !this.isBulkImporting) {
                if (document.activeElement === this.searchInput && this.searchQuery) {
                    return;
                }
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
                await loadCatalog(true);
                if (this.selectedPack) {
                    this.selectedPack = (catalogCache?.packs || []).find(p => p.moduleId === this.selectedPack.moduleId) || null;
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
        if (!this.gridContainer || !catalogCache) return;
        const prevScroll = this.gridContainer.scrollTop;
        this.thumbQueue.reset(this.gridContainer);

        if (this.selectedPack) {
            this._renderScenesView(this.selectedPack);
        } else {
            this._renderPacksView();
        }

        if (typeof options.scrollTop === "number") {
            this.gridContainer.scrollTop = options.scrollTop;
        } else if (options.preserveScroll) {
            this.gridContainer.scrollTop = prevScroll;
        }
    }

    _renderPacksView() {
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

            if (this.searchQuery) {
                const searchBlob = pack._searchBlob || "";
                if (!searchBlob.includes(this.searchQuery)) continue;
            }

            const status = getPackStatus(pack, worldIndex);
            if (this.filterStatus === "imported" && !status.isImported) continue;
            if (this.filterStatus === "not-imported" && status.isImported) continue;

            filtered.push({ pack, status, cleanTitle: getCleanPackTitle(pack) });
        }

        this.countElement.textContent = `${game.i18n.localize("ZMB.Displayed")}: ${filtered.length} / ${packs.length}`;

        if (filtered.length === 0) {
            this.gridContainer.innerHTML = `<div class="zmb-empty" style="grid-column: 1 / -1;">${game.i18n.localize("ZMB.NoResults")}</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();
        const imagesToQueue = [];

        for (const { pack, status, cleanTitle } of filtered) {
            const tile = document.createElement("div");
            tile.className = `zmb-tile ${status.isImported ? "is-imported" : ""}`;

            const versionStr = foundry.utils.escapeHTML(pack.version ? `v${pack.version}` : "v1.0");
            const coverCandidates = getPackCoverCandidates(baseUrl, pack);
            const primaryThumbUrl = coverCandidates[0] || FALLBACK_THUMB;
            const safeTitle = foundry.utils.escapeHTML(cleanTitle);

            const isSceneCat = pack.category === "scene";
            const catLabel = isSceneCat ? game.i18n.localize("ZMB.SceneType") : game.i18n.localize("ZMB.MapType");
            const catClass = isSceneCat ? "cat-scene" : "cat-map";

            let statusLabel = game.i18n.localize("ZMB.NotImportedLabel");
            let statusClass = "";
            if (status.isFullyImported) {
                statusLabel = `${game.i18n.localize("ZMB.ImportedLabel")} (${status.importedCount}/${status.totalCount})`;
                statusClass = "imported";
            } else if (status.isImported) {
                statusLabel = `${game.i18n.localize("ZMB.PartialLabel")} (${status.importedCount}/${status.totalCount})`;
                statusClass = "partial";
            }

            tile.innerHTML = `
            <div class="zmb-thumb">
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
            <button type="button" class="zmb-import-pack" ${status.isFullyImported ? "disabled" : ""}>
            <i class="fa-solid ${status.isFullyImported ? "fa-check" : "fa-file-import"}"></i>
            ${status.isFullyImported ? game.i18n.localize("ZMB.InWorld") : game.i18n.localize("ZMB.Import")}
            </button>
            <button type="button" class="zmb-view-scenes">
            <i class="fa-solid fa-folder-open"></i> ${game.i18n.localize("ZMB.Scenes")}
            </button>
            </div>
            </div>
            `;

            const imgEl = tile.querySelector("img");
            imgEl._fallbacks = coverCandidates.slice(1);
            imagesToQueue.push(imgEl);

            tile.querySelector(".zmb-thumb").addEventListener("click", () => this._openPack(pack));
            tile.querySelector(".zmb-view-scenes").addEventListener("click", () => this._openPack(pack));

            tile.querySelector(".zmb-import-pack").addEventListener("click", async (ev) => {
                const btn = ev.currentTarget;
                const progressFill = tile.querySelector(".zmb-progress-fill");
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
                try {
                    await importPackToWorld(pack, (current, total) => {
                        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${current}/${total}`;
                        if (progressFill && total > 0) {
                            progressFill.style.width = `${Math.round((current / total) * 100)}%`;
                        }
                    });
                    this.refreshGridOnly({ preserveScroll: true });
                } catch (err) {
                    ui.notifications.error(err.message);
                    if (progressFill) progressFill.style.width = "0%";
                    btn.disabled = false;
                    btn.innerHTML = `<i class="fa-solid fa-file-import"></i> ${game.i18n.localize("ZMB.Import")}`;
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
        const packStatus = getPackStatus(pack, worldIndex);

        this.backButton.style.display = "";
        this.catSelect.style.display = "none";
        this.packImportHeaderBtn.style.display = "";
        this.packImportHeaderBtn.disabled = packStatus.isFullyImported;
        this.packImportHeaderBtn.innerHTML = `
        <i class="fa-solid ${packStatus.isFullyImported ? "fa-check" : "fa-file-import"}"></i>
        ${packStatus.isFullyImported
            ? `${game.i18n.localize("ZMB.InWorld")} (${packStatus.importedCount}/${packStatus.totalCount})`
            : `${game.i18n.localize("ZMB.ImportPackBtn")} (${packStatus.importedCount}/${packStatus.totalCount})`}
            `;

            this.gridContainer.innerHTML = "";

            const cleanTitle = getCleanPackTitle(pack);
            const versionStr = foundry.utils.escapeHTML(pack.version ? `v${pack.version}` : "v1.0");
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

            const fragment = document.createDocumentFragment();
            const imagesToQueue = [];

            for (const { sceneMeta, worldScene, isImported } of scenes) {
                const tile = document.createElement("div");
                tile.className = `zmb-tile ${isImported ? "is-imported" : ""}`;
                const thumbCandidates = getSceneThumbCandidates(baseUrl, pack, sceneMeta);
                const primaryThumbUrl = thumbCandidates[0] || FALLBACK_THUMB;
                const sceneName = sceneMeta.name || defaultSceneLabel;
                const safeSceneName = foundry.utils.escapeHTML(sceneName);

                const itemStatus = isImported ? game.i18n.localize("ZMB.ImportedLabel") : game.i18n.localize("ZMB.NotImportedLabel");

                tile.innerHTML = `
                <div class="zmb-thumb" title="${previewHintTitle}">
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
                <button type="button" class="zmb-import-scene" ${isImported ? "disabled" : ""}>
                <i class="fa-solid ${isImported ? "fa-check" : "fa-download"}"></i>
                ${isImported ? game.i18n.localize("ZMB.InWorld") : game.i18n.localize("ZMB.Import")}
                </button>
                <button type="button" class="zmb-open-scene">
                <i class="fa-solid fa-eye"></i> ${game.i18n.localize("ZMB.Open")}
                </button>
                </div>
                </div>
                `;

                const imgEl = tile.querySelector("img");
                imgEl._fallbacks = thumbCandidates.slice(1);
                imagesToQueue.push(imgEl);

                tile.querySelector(".zmb-thumb").addEventListener("click", () => {
                    const previewUrl = resolveAssetUrl(baseUrl, sceneMeta.bg || sceneMeta.thumb, pack.moduleId);
                    openImagePreview(previewUrl, sceneName);
                });

                tile.querySelector(".zmb-import-scene").addEventListener("click", async (ev) => {
                    const btn = ev.currentTarget;
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
                });

                tile.querySelector(".zmb-open-scene").addEventListener("click", async (ev) => {
                    const btn = ev.currentTarget;
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
                });

                fragment.appendChild(tile);
            }

            this.gridContainer.appendChild(fragment);
            for (const img of imagesToQueue) {
                this.thumbQueue.observe(img);
            }
    }
}
