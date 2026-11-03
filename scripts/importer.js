import { MODULE_ID, ROOT_SCENE_FOLDER, delay } from "./constants.js";
import {
    getServerUrl,
    getCleanPackTitle,
    resolveAssetUrl,
    loadPackScenesJson,
    buildWorldSceneIndex,
    findWorldScene
} from "./catalog.js";

const createdDirsCache = new Set();
const existingWorldFilesCache = new Set();
const uploadedAssetsCache = new Map();

export let isBulkImporting = false;

// Globalna kolejka operacji plikowych na serwerze Foundry (zapobiega równoczesnym uploadom i segfaultom Node.js)
let serverOpQueue = Promise.resolve();
function enqueueServerOp(fn) {
    const next = serverOpQueue.then(fn, fn);
    serverOpQueue = next.catch(() => {});
    return next;
}

export function clearImporterCaches() {
    createdDirsCache.clear();
    existingWorldFilesCache.clear();
    uploadedAssetsCache.clear();
}

/* -------------------------------------------- */
/*  Pobieranie plików do folderu świata         */
/* -------------------------------------------- */

async function ensureWorldDirectory(targetDir) {
    if (createdDirsCache.has(targetDir)) return;
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;

    try {
        const browsed = await FP.browse("data", targetDir);
        if (browsed?.files) {
            for (const f of browsed.files) {
                try { existingWorldFilesCache.add(decodeURIComponent(f)); }
                catch { existingWorldFilesCache.add(f); }
            }
        }
        createdDirsCache.add(targetDir);
        return;
    } catch {
        // Katalog jeszcze nie istnieje – utwórz drzewo katalogów poniżej
    }

    const parts = targetDir.split("/").filter(Boolean);
    let current = parts.slice(0, 2).join("/");
    for (let i = 2; i < parts.length; i++) {
        current = `${current}/${parts[i]}`;
        if (createdDirsCache.has(current)) continue;
        try { await FP.createDirectory("data", current); } catch {}
        createdDirsCache.add(current);
    }
}

function buildLocalAssetFilename(trimmedPath) {
    let relInsideModule = trimmedPath.replace(/^\/+/, "");
    if (relInsideModule.startsWith("modules/")) {
        relInsideModule = relInsideModule.split("/").slice(2).join("/");
    }
    const relParts = relInsideModule.split("/").filter(Boolean).map(seg => {
        try { return decodeURIComponent(seg); }
        catch { return seg; }
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

    return enqueueServerOp(async () => {
        if (uploadedAssetsCache.has(cacheKey)) {
            return uploadedAssetsCache.get(cacheKey);
        }

        const cleanFileName = buildLocalAssetFilename(trimmed);
        const safeModuleDir = moduleId.replace(/[^a-zA-Z0-9-_]/g, "_");
        const targetDir = `worlds/${game.world.id}/zychu-maps/${safeModuleDir}/${subFolderHint}`;
        const expectedLocalPath = `${targetDir}/${cleanFileName}`;

        await ensureWorldDirectory(targetDir);

        if (existingWorldFilesCache.has(expectedLocalPath)) {
            uploadedAssetsCache.set(cacheKey, expectedLocalPath);
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
        uploadedAssetsCache.set(cacheKey, savedPath);

        await delay(40);
        return savedPath;
    });
}

/* -------------------------------------------- */
/*  Hierarchia Folderów Scen w Świecie          */
/* -------------------------------------------- */

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
            flags: { [MODULE_ID]: { isRoot: true } }
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
/*  Konwersja i naprawa danych Sceny (v9–v14)   */
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

function sanitizeTileOcclusion(tile) {
    if (!tile || typeof tile.occlusion !== "object" || !tile.occlusion) return;

    const validModes = new Set(
        Object.values(CONST?.TILE_OCCLUSION_MODES || {}).filter(v => v !== undefined && v !== null)
    );
    const fadeMode = CONST?.TILE_OCCLUSION_MODES?.FADE ?? 1;
    const visionMode = CONST?.TILE_OCCLUSION_MODES?.VISION ?? fadeMode;

    const mapSingleMode = (m) => {
        if (validModes.size > 0 && validModes.has(m)) return m;
        if (m === 2) return visionMode;
        if (m === 3) return fadeMode;
        return fadeMode;
    };

    if (typeof tile.occlusion.mode === "number") {
        if (tile.occlusion.mode === 0) {
            if (!validModes.has(0)) delete tile.occlusion.mode;
        } else if (!validModes.has(tile.occlusion.mode)) {
            tile.occlusion.mode = mapSingleMode(tile.occlusion.mode);
        }
    }

    if (Array.isArray(tile.occlusion.modes)) {
        const cleaned = [];
        for (const m of tile.occlusion.modes) {
            if (m === 0 || m === null || m === undefined) continue;
            const mapped = mapSingleMode(m);
            if ((validModes.size === 0 || validModes.has(mapped)) && !cleaned.includes(mapped)) {
                cleaned.push(mapped);
            }
        }
        tile.occlusion.modes = cleaned;
    }
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

    const enforceDefaults = Boolean(game.settings.get(MODULE_ID, "enforceSceneDefaults"));
    const bgColor = enforceDefaults
        ? "#000000"
        : ((typeof raw.backgroundColor === "string" && raw.backgroundColor) ||
           (typeof raw.bgColor === "string" && raw.bgColor) ||
           "#000000");

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
            sanitizeTileOcclusion(tile);
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

    if (Array.isArray(prepared.tokens)) {
        for (const token of prepared.tokens) {
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
        }
    }

    if (Array.isArray(prepared.sounds)) {
        for (const sound of prepared.sounds) {
            sound._id = ensureValidId(sound._id);
            if (sound.path) {
                try {
                    sound.path = await downloadAssetToWorld(baseUrl, sound.path, pack.moduleId, "audio");
                } catch {
                    sound.path = resolveAssetUrl(baseUrl, sound.path, pack.moduleId);
                }
            }
        }
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

    if (Array.isArray(prepared.tiles)) {
        for (const tile of prepared.tiles) {
            sanitizeTileOcclusion(tile);
        }
    }

    if (enforceDefaults) {
        prepared.padding = 0;
        prepared.backgroundColor = "#000000";
        if (Scene.schema?.fields?.transition) {
            prepared.transition = foundry.utils.mergeObject(
                typeof prepared.transition === "object" && prepared.transition ? prepared.transition : {},
                { type: "fade" }
            );
        }
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
    const enforceDefaults = Boolean(game.settings.get(MODULE_ID, "enforceSceneDefaults"));

    for (const sceneDoc of createdDocs) {
        const expectedBg = sceneDoc.getFlag(MODULE_ID, "bgPath");
        if (!expectedBg) continue;

        const firstLevel = sceneDoc.levels?.contents?.[0];
        if (!firstLevel) continue;

        const needsSrcUpdate = firstLevel.background?.src !== expectedBg;
        const needsColorUpdate = enforceDefaults && firstLevel.background?.color !== "#000000";

        if (needsSrcUpdate || needsColorUpdate) {
            try {
                const updateData = { "background.src": expectedBg };
                if (enforceDefaults) {
                    updateData["background.color"] = "#000000";
                }
                await firstLevel.update(updateData);
            } catch (err) {
                console.warn(`[${MODULE_ID}] Failed to update level background:`, err);
            }
        }
    }
}

/* -------------------------------------------- */
/*  Akcje Importu do Świata                     */
/* -------------------------------------------- */

export async function importPackToWorld(pack, onProgress = null) {
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
            console.warn(`[${MODULE_ID}] Skipped broken scene "${meta?.name || raw.name}":`, err);
        }
    }

    if (toCreate.length === 0) {
        throw new Error(game.i18n.format("ZMB.PackImportAllFailed", { title: packTitle }));
    }

    isBulkImporting = true;
    let createdDocs = [];
    try {
        createdDocs = await Scene.createDocuments(toCreate);
        await ensureCreatedScenesHaveLevelBg(createdDocs);
    } finally {
        isBulkImporting = false;
    }

    const createdCount = createdDocs?.length || toCreate.length;
    if (skippedCount > 0) {
        ui.notifications.warn(game.i18n.format("ZMB.PackImportedWarn", { count: createdCount, title: packTitle, skipped: skippedCount }));
    } else {
        ui.notifications.info(game.i18n.format("ZMB.PackImportedInfo", { count: createdCount, title: packTitle }));
    }
}

export async function importSingleSceneToWorld(pack, sceneMeta) {
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

    isBulkImporting = true;
    let created = null;
    try {
        created = await Scene.create(prepared);
        if (!created) {
            throw new Error(game.i18n.format("ZMB.SceneCreateError", { name: sceneMeta.name }));
        }
        await ensureCreatedScenesHaveLevelBg([created]);
    } finally {
        isBulkImporting = false;
    }

    ui.notifications.info(game.i18n.format("ZMB.SceneImportedInfo", { name: created.name }));
    return created;
}