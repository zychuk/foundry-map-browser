const MODULE_ID = "zychu-map-browser";
const { ApplicationV2 } = foundry.applications.api;

function t(key, data = null) {
    if (data) return game.i18n.format(key, data);
    return game.i18n.localize(key);
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const activePackImports = new Set();
const activeSceneImports = new Set();
const scenesJsonCache = new Map();
const existingWorldFilesCache = new Map();

let serverOpChain = Promise.resolve();
function enqueueServerOp(taskFn) {
    const res = serverOpChain.then(() => taskFn());
    serverOpChain = res.catch(() => {});
    return res;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getFP() {
    return foundry?.applications?.apps?.FilePicker?.implementation || FilePicker;
}

function getServerBaseUrl() {
    const raw = (game.settings.get(MODULE_ID, "serverUrl") || "").trim();
    return raw.replace(/\/+$/, "");
}

function encodeRelativeAssetPath(relPath) {
    if (!relPath || typeof relPath !== "string") return "";
    const trimmed = relPath.trim().replace(/^\/+/, "");
    return trimmed
    .split("/")
    .map(segment => {
        try {
            return encodeURIComponent(decodeURIComponent(segment));
        } catch (e) {
            return encodeURIComponent(segment);
        }
    })
    .join("/");
}

function normalizeServerAssetPath(assetPath, moduleId) {
    if (!assetPath || typeof assetPath !== "string") return null;
    const clean = assetPath.trim();
    if (!clean) return null;

    if (
        clean.startsWith("http://") ||
        clean.startsWith("https://") ||
        clean.startsWith("data:") ||
        clean.startsWith("icons/") ||
        clean.startsWith("ui/") ||
        clean.startsWith("systems/") ||
        clean.startsWith("worlds/")
    ) {
        return null;
    }

    const noLeadingSlash = clean.replace(/^\/+/, "");
    if (noLeadingSlash.startsWith("modules/")) {
        const parts = noLeadingSlash.split("/");
        if (moduleId && parts.length > 2) {
            parts[1] = moduleId;
        }
        return parts.join("/");
    }

    if (moduleId) {
        return `modules/${moduleId}/${noLeadingSlash}`;
    }
    return noLeadingSlash;
}

function resolveRemoteAssetUrl(baseUrl, assetPath, moduleId) {
    if (!assetPath || typeof assetPath !== "string") return "";
    const clean = assetPath.trim();
    if (clean.startsWith("http://") || clean.startsWith("https://") || clean.startsWith("data:")) {
        return clean;
    }
    const rel = normalizeServerAssetPath(clean, moduleId);
    if (!rel) return clean;
    return `${baseUrl}/${encodeRelativeAssetPath(rel)}`;
}

function swapExtensionToWebp(pathStr) {
    if (!pathStr || typeof pathStr !== "string") return null;
    if (!/\.(jpg|jpeg|png|webp)$/i.test(pathStr)) return null;
    return pathStr.replace(/\.[a-zA-Z0-9]+$/, ".webp");
}

function toThumbsFolderWebp(pathStr, moduleId) {
    const norm = normalizeServerAssetPath(pathStr, moduleId);
    if (!norm) return null;
    const filename = norm.split("/").pop();
    if (!filename) return null;
    const stem = filename.replace(/\.[a-zA-Z0-9]+$/, "");
    if (!stem) return null;
    return `modules/${moduleId}/_thumbs/${stem}.webp`;
}

function getPackThumbnailCandidates(baseUrl, pack) {
    const rawCandidates = [];
    const seen = new Set();

    const addCandidate = (rawPath) => {
        if (!rawPath || typeof rawPath !== "string") return;
        const url = resolveRemoteAssetUrl(baseUrl, rawPath, pack.moduleId);
        if (url && !seen.has(url)) {
            seen.add(url);
            rawCandidates.push(url);
        }
    };

    if (pack.cover) {
        addCandidate(pack.cover);
        addCandidate(toThumbsFolderWebp(pack.cover, pack.moduleId));
        addCandidate(swapExtensionToWebp(pack.cover));
    }

    if (Array.isArray(pack.scenes)) {
        for (const s of pack.scenes) {
            if (rawCandidates.length >= 4) break;
            if (s.thumb) {
                addCandidate(s.thumb);
                addCandidate(toThumbsFolderWebp(s.thumb, pack.moduleId));
            }
        }
        for (const s of pack.scenes) {
            if (rawCandidates.length >= 5) break;
            if (s.bg) {
                addCandidate(toThumbsFolderWebp(s.bg, pack.moduleId));
                addCandidate(s.bg);
            }
        }
    }

    return rawCandidates.slice(0, 5);
}

function getSceneThumbnailCandidates(baseUrl, moduleId, scene) {
    const rawCandidates = [];
    const seen = new Set();

    const addCandidate = (rawPath) => {
        if (!rawPath || typeof rawPath !== "string") return;
        const url = resolveRemoteAssetUrl(baseUrl, rawPath, moduleId);
        if (url && !seen.has(url)) {
            seen.add(url);
            rawCandidates.push(url);
        }
    };

    if (scene.thumb) {
        addCandidate(scene.thumb);
        addCandidate(toThumbsFolderWebp(scene.thumb, moduleId));
        addCandidate(swapExtensionToWebp(scene.thumb));
    }
    if (scene.bg) {
        addCandidate(toThumbsFolderWebp(scene.bg, moduleId));
        addCandidate(scene.bg);
        addCandidate(swapExtensionToWebp(scene.bg));
    }

    return rawCandidates.slice(0, 5);
}

function extractRawSceneBgPath(rawScene) {
    if (!rawScene || typeof rawScene !== "object") return null;
    if (rawScene.background?.src) return rawScene.background.src;
    if (rawScene.img) return rawScene.img;
    if (Array.isArray(rawScene.levels) && rawScene.levels[0]?.background?.src) {
        return rawScene.levels[0].background.src;
    }
    return rawScene.bg || null;
}

class ThumbnailQueue {
    constructor(concurrency = 6) {
        this.concurrency = concurrency;
        this.active = 0;
        this.queue = [];
        this.observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    this.observer.unobserve(img);
                    this.enqueue(img, true);
                }
            }
        }, { rootMargin: "250px 0px" });
    }

    observe(img) {
        if (!img || !img.dataset.src) return;
        this.observer.observe(img);
    }

    enqueue(img, prioritize = false) {
        if (!img || img._queued || img._loaded) return;
        img._queued = true;
        if (prioritize) {
            this.queue.unshift(img);
        } else {
            this.queue.push(img);
        }
        this.process();
    }

    process() {
        while (this.active < this.concurrency && this.queue.length > 0) {
            const img = this.queue.shift();
            if (!img || !img.isConnected) continue;

            this.active++;
            const src = img.dataset.src;

            const finish = () => {
                img._loaded = true;
                this.active--;
                this.process();
            };

            img.onload = () => {
                img.classList.add("loaded");
                finish();
            };

            img.onerror = () => {
                if (Array.isArray(img._fallbacks) && img._fallbacks.length > 0) {
                    const nextUrl = img._fallbacks.shift();
                    img.src = nextUrl;
                    return;
                }
                img.onload = null;
                img.onerror = null;
                img.src = "icons/svg/direction.svg";
                img.classList.add("loaded");
                finish();
            };

            img.src = src;
        }
    }

    disconnect() {
        this.observer.disconnect();
        this.queue = [];
    }
}

function cleanPackTitle(pack) {
    if (pack._cleanTitle) return pack._cleanTitle;
    let title = pack.title || pack.moduleId || "Unknown Pack";
    return title
    .replace(/^(Cze and Peku\s*-\s*|Czepeku Scenes\s*-\s*|Czepeku\s*-\s*)/i, "")
    .trim();
}

function getSortableTitle(cleanTitle) {
    return cleanTitle.replace(/^\d+\s*[-–.]*\s*/, "").trim();
}

const existingDirsCache = new Set();

function ensureWorldDirectory(targetDir) {
    if (existingDirsCache.has(targetDir)) return Promise.resolve();

    return enqueueServerOp(async () => {
        if (existingDirsCache.has(targetDir)) return;
        const FP = getFP();
        const parts = targetDir.split("/").filter(Boolean);
        let currentPath = "";

        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            if (existingDirsCache.has(currentPath)) continue;

            try {
                const browsed = await FP.browse("data", currentPath);
                existingDirsCache.add(currentPath);
                if (Array.isArray(browsed?.files)) {
                    const fileSet = new Set(browsed.files.map(f => {
                        try { return decodeURIComponent(f.split("/").pop()); }
                        catch (err) { return f.split("/").pop(); }
                    }));
                    existingWorldFilesCache.set(currentPath, fileSet);
                }
                continue;
            } catch (browseErr) {
                // Folder nie istnieje – utwórz go poniżej
            }

            try {
                await FP.createDirectory("data", currentPath);
                existingDirsCache.add(currentPath);
                existingWorldFilesCache.set(currentPath, new Set());
            } catch (e) {
                const msg = String(e?.message || e || "");
                if (!msg.includes("EEXIST") && !msg.includes("already exists")) {
                    console.warn(`Map Browser | Info tworzenia katalogu ${currentPath}:`, e);
                }
                existingDirsCache.add(currentPath);
            }
        }
    });
}

function buildLocalAssetFilename(relPath, moduleId) {
    const prefix = `modules/${moduleId}/`;
    let inner = relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
    try {
        inner = decodeURIComponent(inner);
    } catch (e) {
        // Ignoruj błędy dekodowania
    }
    inner = inner.replace(/^_thumbs\//i, "");
    const flatName = inner.replace(/[\/\\]+/g, "_").replace(/\s+/g, "_");
    return flatName || "asset.webp";
}

async function downloadAssetToWorld(baseUrl, assetPath, moduleId, subfolder = "maps") {
    if (!assetPath || typeof assetPath !== "string") return assetPath;

    const relPath = normalizeServerAssetPath(assetPath, moduleId);
    if (!relPath) return assetPath;

    const safeFileName = buildLocalAssetFilename(relPath, moduleId);
    const targetDir = `worlds/${game.world.id}/zychu-maps/${moduleId}/${subfolder}`;
    const expectedLocalPath = `${targetDir}/${safeFileName}`;

    await ensureWorldDirectory(targetDir);

    const knownFiles = existingWorldFilesCache.get(targetDir);
    if (knownFiles && knownFiles.has(safeFileName)) {
        return expectedLocalPath;
    }

    const remoteUrl = `${baseUrl}/${encodeRelativeAssetPath(relPath)}`;

    try {
        const response = await fetch(remoteUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} (${remoteUrl})`);
        }
        const blob = await response.blob();
        const file = new File([blob], safeFileName, { type: blob.type || "application/octet-stream" });

        return await enqueueServerOp(async () => {
            const currentKnown = existingWorldFilesCache.get(targetDir);
            if (currentKnown && currentKnown.has(safeFileName)) {
                return expectedLocalPath;
            }
            const FP = getFP();
            const uploadResult = await FP.upload("data", targetDir, file, {}, { notify: false });
            await delay(40);

            if (currentKnown) currentKnown.add(safeFileName);
            return uploadResult?.path || expectedLocalPath;
        });
    } catch (err) {
        console.error(`Map Browser | Nie udało się pobrać pliku ${remoteUrl}:`, err);
        return remoteUrl;
    }
}

function normalizeLegacyWalls(walls) {
    if (!Array.isArray(walls)) return [];
    const WALL_SENSE_TYPES = { NONE: 0, LIMITED: 10, NORMAL: 20, PROXIMITY: 30, DISTANCE: 40 };

    return walls
    .filter(w => Array.isArray(w.c) && w.c.length === 4 && w.c.every(n => Number.isFinite(Number(n))))
    .map(w => {
        const wall = foundry.utils.deepClone(w);
        wall.c = wall.c.map(n => Math.round(Number(n)));

        if (wall.sense !== undefined && wall.light === undefined) {
            const legacySense = Number(wall.sense);
            const mapped = legacySense === 0
            ? WALL_SENSE_TYPES.NONE
            : (legacySense === 2 ? WALL_SENSE_TYPES.LIMITED : WALL_SENSE_TYPES.NORMAL);
            wall.light = mapped;
            wall.sight = mapped;
            wall.sound = mapped;
            delete wall.sense;
        }

        if (typeof wall.move === "number" && wall.move <= 2) {
            wall.move = wall.move === 0 ? WALL_SENSE_TYPES.NONE : WALL_SENSE_TYPES.NORMAL;
        }
        if (typeof wall.light === "number" && wall.light <= 2) {
            wall.light = wall.light === 0
            ? WALL_SENSE_TYPES.NONE
            : (wall.light === 2 ? WALL_SENSE_TYPES.LIMITED : WALL_SENSE_TYPES.NORMAL);
        }
        if (typeof wall.sight === "number" && wall.sight <= 2) {
            wall.sight = wall.sight === 0
            ? WALL_SENSE_TYPES.NONE
            : (wall.sight === 2 ? WALL_SENSE_TYPES.LIMITED : WALL_SENSE_TYPES.NORMAL);
        }
        if (typeof wall.sound === "number" && wall.sound <= 2) {
            wall.sound = wall.sound === 0
            ? WALL_SENSE_TYPES.NONE
            : (wall.sound === 2 ? WALL_SENSE_TYPES.LIMITED : WALL_SENSE_TYPES.NORMAL);
        }

        return wall;
    });
}

function applyDefaultSceneVisuals(sceneData) {
    sceneData.padding = 0;
    sceneData.backgroundColor = "#000000";

    if (foundry?.documents?.BaseScene?.schema?.fields?.transition) {
        sceneData.transition = foundry.utils.mergeObject(
            { type: "fade" },
            sceneData.transition || {},
            { inplace: false }
        );
        sceneData.transition.type = "fade";
    }
    return sceneData;
}

async function prepareSceneDataWithLocalAssets(rawScene, folderId, baseUrl, pack) {
    const s = foundry.utils.deepClone(rawScene);
    const moduleId = pack.moduleId;
    const rawBg = extractRawSceneBgPath(s);

    const localBgPath = rawBg
    ? await downloadAssetToWorld(baseUrl, rawBg, moduleId, "maps")
    : null;

    let localThumbPath = localBgPath;
    if (s.thumb && s.thumb !== rawBg) {
        const dlThumb = await downloadAssetToWorld(baseUrl, s.thumb, moduleId, "thumbs");
        if (dlThumb && !dlThumb.startsWith("http")) {
            localThumbPath = dlThumb;
        }
    }

    let localFgPath = null;
    if (typeof s.foreground === "string" && s.foreground.trim()) {
        localFgPath = await downloadAssetToWorld(baseUrl, s.foreground, moduleId, "maps");
    }

    if (Array.isArray(s.tiles) && s.tiles.length > 0) {
        for (const tile of s.tiles) {
            const tileSrc = tile.texture?.src || tile.img;
            if (tileSrc) {
                const localTile = await downloadAssetToWorld(baseUrl, tileSrc, moduleId, "tiles");
                if (tile.texture && typeof tile.texture === "object") {
                    tile.texture.src = localTile;
                } else {
                    tile.texture = { src: localTile };
                }
                delete tile.img;
            }
        }
    }

    if (Array.isArray(s.tokens) && s.tokens.length > 0) {
        for (const tok of s.tokens) {
            const tokSrc = tok.texture?.src || tok.img;
            if (tokSrc) {
                const localTok = await downloadAssetToWorld(baseUrl, tokSrc, moduleId, "tokens");
                if (tok.texture && typeof tok.texture === "object") {
                    tok.texture.src = localTok;
                } else {
                    tok.texture = { src: localTok };
                }
                delete tok.img;
            }
        }
    }

    if (Array.isArray(s.sounds) && s.sounds.length > 0) {
        for (const snd of s.sounds) {
            if (snd.path) {
                snd.path = await downloadAssetToWorld(baseUrl, snd.path, moduleId, "audio");
            }
        }
    }

    let gridObj;
    if (typeof s.grid === "number") {
        gridObj = {
            size: s.grid || 100,
            type: s.gridType ?? 1,
            distance: s.gridDistance || 5,
            units: s.gridUnits || "ft",
            color: s.gridColor || "#000000",
            alpha: s.gridAlpha ?? 0.2
        };
    } else if (s.grid && typeof s.grid === "object") {
        gridObj = foundry.utils.mergeObject(
            { size: 100, type: 1, distance: 5, units: "ft" },
            s.grid
        );
    } else {
        gridObj = { size: 100, type: 1, distance: 5, units: "ft" };
    }

    const bgOffsetX = s.background?.offsetX ?? s.shiftX ?? 0;
    const bgOffsetY = s.background?.offsetY ?? s.shiftY ?? 0;

    delete s.img;
    delete s.shiftX;
    delete s.shiftY;
    delete s.gridType;
    delete s.gridDistance;
    delete s.gridUnits;
    delete s.gridColor;
    delete s.gridAlpha;

    const sceneData = foundry.utils.mergeObject(s, {
        name: s.name || "Imported Scene",
        folder: folderId,
        width: Number(s.width) || 4000,
                                                height: Number(s.height) || 3000,
                                                background: {
                                                    src: localBgPath,
                                                    offsetX: bgOffsetX,
                                                    offsetY: bgOffsetY
                                                },
                                                foreground: localFgPath,
                                                    thumb: localThumbPath,
                                                    grid: gridObj,
                                                    walls: normalizeLegacyWalls(s.walls),
                                                lights: Array.isArray(s.lights) ? s.lights : [],
                                                tiles: Array.isArray(s.tiles) ? s.tiles : [],
                                                drawings: Array.isArray(s.drawings) ? s.drawings : [],
                                                sounds: Array.isArray(s.sounds) ? s.sounds : [],
                                                notes: Array.isArray(s.notes) ? s.notes : [],
                                                tokens: Array.isArray(s.tokens) ? s.tokens : [],
                                                flags: foundry.utils.mergeObject(s.flags || {}, {
                                                    [MODULE_ID]: {
                                                        moduleId: pack.moduleId,
                                                        sceneId: rawScene._id || rawScene.id || foundry.utils.randomID(),
                                                                                 version: pack.version || "1.0.0",
                                                                                 bgPath: localBgPath
                                                    }
                                                })
    });

    applyDefaultSceneVisuals(sceneData);

    const isV14LevelsSupported = Boolean(foundry?.documents?.BaseScene?.schema?.fields?.levels);
    if (isV14LevelsSupported) {
        if (Array.isArray(sceneData.levels) && sceneData.levels.length > 0) {
            for (const lvl of sceneData.levels) {
                const lvlBg = lvl?.background?.src;
                if (lvlBg) {
                    if (lvlBg === rawBg && localBgPath) {
                        lvl.background.src = localBgPath;
                    } else {
                        lvl.background.src = await downloadAssetToWorld(baseUrl, lvlBg, moduleId, "maps");
                    }
                } else if (localBgPath && lvl === sceneData.levels[0]) {
                    lvl.background = foundry.utils.mergeObject(lvl.background || {}, { src: localBgPath });
                }
            }
        } else if (localBgPath) {
            const levelId = foundry.utils.randomID();
            sceneData.initialLevel = levelId;
            sceneData.levels = [{
                _id: levelId,
                name: "Initial Level",
                background: {
                    src: localBgPath
                }
            }];
        }
    }

    return sceneData;
}

async function ensureCreatedScenesHaveLevelBg(createdScenes) {
    if (!Array.isArray(createdScenes) || !foundry?.documents?.BaseScene?.schema?.fields?.levels) return;

    for (const sceneDoc of createdScenes) {
        const bgPath = sceneDoc.getFlag(MODULE_ID, "bgPath") || sceneDoc.background?.src;
        if (!bgPath) continue;

        if (sceneDoc.levels && sceneDoc.levels.size > 0) {
            const firstLevel = sceneDoc.levels.first();
            if (firstLevel && !firstLevel.background?.src) {
                try {
                    await firstLevel.update({ "background.src": bgPath });
                } catch (err) {
                    console.warn("Map Browser | Aktualizacja tła poziomu v14 nie powiodła się:", err);
                }
            }
        }
    }
}

async function fetchPackScenesJson(baseUrl, moduleId) {
    if (scenesJsonCache.has(moduleId)) {
        return foundry.utils.deepClone(scenesJsonCache.get(moduleId));
    }
    const encodedModId = encodeURIComponent(moduleId);
    const res = await fetch(`${baseUrl}/modules/${encodedModId}/scenes.json`);
    if (!res.ok) throw new Error(t("ZMB.NotifyNoScenesJson"));
    const data = await res.json();
    scenesJsonCache.set(moduleId, data);
    return foundry.utils.deepClone(data);
}

async function getOrCreatePackFolder(pack) {
    let rootFolder = game.folders.find(f => f.type === "Scene" && f.name === "Zychu Maps" && !f.folder);
    if (!rootFolder) {
        rootFolder = await Folder.create({ name: "Zychu Maps", type: "Scene", color: "#1e293b" });
    }

    const packFolderName = cleanPackTitle(pack);
    let packFolder = game.folders.find(f =>
    f.type === "Scene" &&
    f.name === packFolderName &&
    (f.folder?.id === rootFolder.id || f.folder === rootFolder.id)
    );

    if (!packFolder) {
        packFolder = await Folder.create({ name: packFolderName, type: "Scene", folder: rootFolder.id });
    }

    return packFolder;
}

function getImportedSceneMapForPack(moduleId) {
    const map = new Map();
    for (const scene of game.scenes) {
        const flag = scene.flags?.[MODULE_ID];
        if (flag && flag.moduleId === moduleId && flag.sceneId) {
            map.set(flag.sceneId, scene);
        }
    }
    return map;
}

function openImagePreview(src, title) {
    const AppV2Popout = foundry?.applications?.apps?.ImagePopout;
    if (AppV2Popout && Object.prototype.isPrototypeOf.call(ApplicationV2, AppV2Popout)) {
        new AppV2Popout({ src, window: { title } }).render(true);
    } else {
        new ImagePopout(src, { title }).render(true);
    }
}

/* ------------------------------------------------------------- */
/*  Efekt YouTube Ambient Light (Ambilight) wokół krawędzi mapy  */
/* ------------------------------------------------------------- */

let currentAmbilightSprite = null;

function destroyAmbilightSprite() {
    if (currentAmbilightSprite) {
        try {
            currentAmbilightSprite.parent?.removeChild(currentAmbilightSprite);
            currentAmbilightSprite.destroy({ children: true, texture: true, baseTexture: true });
        } catch (e) {
            // Ignoruj błędy przy zamykaniu sceny
        }
        currentAmbilightSprite = null;
    }
}

async function renderSceneAmbilight(canvasInstance) {
    destroyAmbilightSprite();

    try {
        if (!game.settings.get(MODULE_ID, "enableAmbilight")) return;
        if (!canvasInstance?.ready || !canvasInstance?.dimensions?.sceneRect) return;

        const sr = canvasInstance.dimensions.sceneRect;
        if (!sr || sr.width <= 0 || sr.height <= 0) return;

        const bgSrc =
        canvasInstance.level?.background?.src ||
        canvasInstance.scene?.background?.src ||
        canvasInstance.primary?.background?.texture?.baseTexture?.resource?.url;

        if (!bgSrc || /\.(webm|mp4|m4v|ogg)$/i.test(bgSrc)) return;

        const img = new Image();
        img.crossOrigin = "anonymous";
        const loaded = await new Promise((resolve) => {
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = bgSrc;
        });
        if (!loaded || !canvasInstance.ready) return;

        // Generujemy pojedynczą teksturę 512x512 z rozmytą poświatą krawędzi i wyciętym środkiem
        const SIZE = 512;
        const MARGIN = 88;
        const INNER = SIZE - MARGIN * 2;

        const offCanvas = document.createElement("canvas");
        offCanvas.width = SIZE;
        offCanvas.height = SIZE;
        const ctx = offCanvas.getContext("2d");

        // 1. Narysuj rozmytą, nasyconą poświatę z kolorów mapy
        ctx.save();
        ctx.filter = "blur(32px) saturate(1.55) brightness(0.85)";
        ctx.drawImage(img, MARGIN - 10, MARGIN - 10, INNER + 20, INNER + 20);
        ctx.restore();

        // 2. Wygaś zewnętrzne brzegi tekstury 512x512 miękko do zera, żeby poświata nie miała ostrej ramki
        ctx.save();
        ctx.globalCompositeOperation = "destination-in";
        const grad = ctx.createRadialGradient(SIZE / 2, SIZE / 2, INNER * 0.42, SIZE / 2, SIZE / 2, SIZE * 0.5);
        grad.addColorStop(0, "rgba(0,0,0,1)");
        grad.addColorStop(0.78, "rgba(0,0,0,0.85)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.restore();

        // 3. Wytnij środek mapy z lekkim wtopieniem (feather 8px), aby środek mapy był w 100% ostry i nietknięty
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.filter = "blur(7px)";
        ctx.fillStyle = "#000000";
        ctx.fillRect(MARGIN + 5, MARGIN + 5, INNER - 10, INNER - 10);
        ctx.restore();

        // 4. Dodaj delikatną ciemną winietę na samym styku krawędzi mapy
        ctx.save();
        ctx.filter = "blur(6px)";
        ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
        ctx.lineWidth = 8;
        ctx.strokeRect(MARGIN, MARGIN, INNER, INNER);
        ctx.restore();

        const tex = PIXI.Texture.from(offCanvas);
        const sprite = new PIXI.Sprite(tex);

        const padX = sr.width * (MARGIN / INNER);
        const padY = sr.height * (MARGIN / INNER);

        sprite.x = sr.x - padX;
        sprite.y = sr.y - padY;
        sprite.width = sr.width + padX * 2;
        sprite.height = sr.height + padY * 2;
        sprite.alpha = 0.92;
        sprite.eventMode = "none";
        sprite.interactiveChildren = false;

        // Umieść poświatę na scenie
        const parentContainer = canvasInstance.stage;
        if (parentContainer) {
            const primaryIdx = parentContainer.children.indexOf(canvasInstance.primary);
            if (primaryIdx >= 0) {
                parentContainer.addChildAt(sprite, primaryIdx + 1);
            } else {
                parentContainer.addChild(sprite);
            }
            currentAmbilightSprite = sprite;
        }
    } catch (err) {
        console.warn("Map Browser | Nie udało się wyrenderować poświaty Ambilight:", err);
    }
}

class HomelabMapBrowser extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: "zychu-map-browser-app",
        tag: "div",
        window: {
            title: "ZMB.WindowTitle",
            icon: "fas fa-map-marked-alt",
            resizable: true
        },
        position: {
            width: 1020,
            height: 760
        }
    };

    constructor(options = {}) {
        super(options);
        this.catalog = null;
        this.selectedPack = null;
        this.searchQuery = "";
        this.savedPackSearchQuery = "";
        this.categoryFilter = "all";
        this.importFilter = "all";
        this.thumbQueue = new ThumbnailQueue(6);
        this._searchTimeout = null;
        this._savedScrollTop = 0;
    }

    async _prepareContext() {
        return {};
    }

    async _onClose(options) {
        this.thumbQueue.disconnect();
        if (this._searchTimeout) clearTimeout(this._searchTimeout);
        return super._onClose(options);
    }

    async _renderHTML() {
        const wrapper = document.createElement("div");
        wrapper.className = "zmb-wrapper";
        wrapper.innerHTML = `<div class="zmb-status"><i class="fas fa-spinner fa-spin"></i> ${t("ZMB.LoadingCatalog")}</div>`;
        return wrapper;
    }

    _replaceHTML(result, content) {
        content.replaceChildren(result);
        this.loadCatalog(result);
    }

    async loadCatalog(container) {
        const baseUrl = getServerBaseUrl();
        try {
            const response = await fetch(`${baseUrl}/catalog.json`, { cache: "no-cache" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            this.catalog = await response.json();

            if (Array.isArray(this.catalog.packs)) {
                for (const pack of this.catalog.packs) {
                    pack._cleanTitle = cleanPackTitle(pack);
                    pack._sortKey = getSortableTitle(pack._cleanTitle);
                    const sceneNames = Array.isArray(pack.scenes)
                    ? pack.scenes.map(s => s.name || "").join(" ")
                    : "";
                    pack._searchBlob = `${pack._cleanTitle} ${pack.title || ""} ${pack.moduleId || ""} ${sceneNames}`.toLowerCase();
                }

                this.catalog.packs.sort((a, b) => {
                    const cmp = naturalCollator.compare(a._sortKey, b._sortKey);
                    if (cmp !== 0) return cmp;
                    return naturalCollator.compare(a._cleanTitle, b._cleanTitle);
                });
            }

            this.renderView(container);
        } catch (err) {
            console.error("Map Browser | Błąd ładowania catalog.json:", err);
            container.innerHTML = `
            <div class="zmb-status" style="color: #ef4444;">
            <i class="fas fa-exclamation-triangle"></i> ${t("ZMB.ErrorCatalogLoad", { url: baseUrl })}<br>
            <small>${err.message}</small>
            </div>`;
        }
    }

    refreshIfOpen() {
        if (!this.rendered || !this.element) return;
        const container = this.element.querySelector(".zmb-wrapper");
        if (!container || !this.catalog) return;

        const gridEl = container.querySelector(".zmb-grid");
        if (this.selectedPack) {
            if (gridEl) this.populateVariantsGrid(gridEl, container);
            else this.renderVariantsView(container);
        } else {
            if (gridEl) this.populatePacksGrid(gridEl, container);
            else this.renderPacksView(container);
        }
    }

    renderView(container) {
        this.thumbQueue.disconnect();
        if (this.selectedPack) {
            this.renderVariantsView(container);
        } else {
            this.renderPacksView(container);
        }
    }

    renderPacksView(container) {
        container.innerHTML = `
        <div class="zmb-toolbar">
        <input type="text" class="zmb-search" placeholder="${t("ZMB.SearchPlaceholder")}" value="${this.searchQuery}">
        <select class="zmb-select zmb-cat-select">
        <option value="all" ${this.categoryFilter === "all" ? "selected" : ""}>${t("ZMB.FilterCatAll")}</option>
        <option value="map" ${this.categoryFilter === "map" ? "selected" : ""}>${t("ZMB.FilterCatMaps")}</option>
        <option value="scene" ${this.categoryFilter === "scene" ? "selected" : ""}>${t("ZMB.FilterCatScenes")}</option>
        </select>
        <select class="zmb-select zmb-imp-select">
        <option value="all" ${this.importFilter === "all" ? "selected" : ""}>${t("ZMB.FilterImpAll")}</option>
        <option value="not-imported" ${this.importFilter === "not-imported" ? "selected" : ""}>${t("ZMB.FilterImpNot")}</option>
        <option value="imported" ${this.importFilter === "imported" ? "selected" : ""}>${t("ZMB.FilterImpYes")}</option>
        </select>
        <span class="zmb-count"></span>
        </div>
        <div class="zmb-grid"></div>
        `;

        const searchInput = container.querySelector(".zmb-search");
        const catSelect = container.querySelector(".zmb-cat-select");
        const impSelect = container.querySelector(".zmb-imp-select");
        const grid = container.querySelector(".zmb-grid");

        searchInput.addEventListener("input", (e) => {
            if (this._searchTimeout) clearTimeout(this._searchTimeout);
            this._searchTimeout = setTimeout(() => {
                this.searchQuery = e.target.value.toLowerCase().trim();
                this.populatePacksGrid(grid, container);
            }, 140);
        });

        catSelect.addEventListener("change", (e) => {
            this.categoryFilter = e.target.value;
            this.populatePacksGrid(grid, container);
        });

        impSelect.addEventListener("change", (e) => {
            this.importFilter = e.target.value;
            this.populatePacksGrid(grid, container);
        });

        this.populatePacksGrid(grid, container);

        if (this._savedScrollTop > 0) {
            requestAnimationFrame(() => {
                grid.scrollTop = this._savedScrollTop;
            });
        }
    }

    populatePacksGrid(grid, container) {
        this.thumbQueue.disconnect();
        grid.innerHTML = "";
        const baseUrl = getServerBaseUrl();
        const packs = this.catalog?.packs || [];

        const filtered = [];
        for (const pack of packs) {
            const cat = pack.category || "map";
            if (this.categoryFilter !== "all" && cat !== this.categoryFilter) continue;

            if (this.searchQuery && !(pack._searchBlob || "").includes(this.searchQuery)) {
                continue;
            }

            const importedMap = getImportedSceneMapForPack(pack.moduleId);
            const importedCount = importedMap.size;
            const totalScenes = Array.isArray(pack.scenes) ? pack.scenes.length : (pack.sceneCount || 0);
            const isFullyImported = totalScenes > 0 && importedCount >= totalScenes;
            const isPartiallyImported = importedCount > 0 && !isFullyImported;

            if (this.importFilter === "imported" && importedCount === 0) continue;
            if (this.importFilter === "not-imported" && isFullyImported) continue;

            filtered.push({ pack, importedCount, totalScenes, isFullyImported, isPartiallyImported });
        }

        const countSpan = container.querySelector(".zmb-count");
        if (countSpan) {
            countSpan.textContent = `${filtered.length} / ${packs.length}`;
        }

        if (filtered.length === 0) {
            grid.innerHTML = `<div class="zmb-status">${t("ZMB.NoResults")}</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();

        for (const { pack, importedCount, totalScenes, isFullyImported, isPartiallyImported } of filtered) {
            const displayTitle = cleanPackTitle(pack);
            const candidates = getPackThumbnailCandidates(baseUrl, pack);
            const primaryThumb = candidates[0] || "icons/svg/direction.svg";
            const fallbacks = candidates.slice(1);

            const isSceneCat = pack.category === "scene";
            const isBusy = activePackImports.has(pack.moduleId);

            let statusTagHtml = "";
            if (isFullyImported) {
                statusTagHtml = `<span class="zmb-tag status-imported"><i class="fas fa-check"></i> ${t("ZMB.TagImported")}</span>`;
            } else if (isPartiallyImported) {
                statusTagHtml = `<span class="zmb-tag status-partial"><i class="fas fa-adjust"></i> ${importedCount}/${totalScenes}</span>`;
            }

            let importBtnLabel;
            if (isBusy) {
                importBtnLabel = `<i class="fas fa-spinner fa-spin"></i>`;
            } else if (isFullyImported) {
                importBtnLabel = `<i class="fas fa-sync-alt"></i> ${t("ZMB.BtnReimport")}`;
            } else if (isPartiallyImported) {
                importBtnLabel = `<i class="fas fa-download"></i> ${t("ZMB.BtnImportMissing")}`;
            } else {
                importBtnLabel = `<i class="fas fa-download"></i> ${t("ZMB.BtnImportPack")}`;
            }

            const tile = document.createElement("div");
            tile.className = `zmb-tile ${isFullyImported ? "is-imported" : ""}`;
            tile.innerHTML = `
            <div class="zmb-thumb">
            <img data-src="${primaryThumb}" alt="${displayTitle}">
            <div class="zmb-tags-top">
            <span class="zmb-tag ${isSceneCat ? "cat-scene" : "cat-map"}">
            ${isSceneCat ? t("ZMB.TagScene") : t("ZMB.TagMap")} • ${totalScenes}
            </span>
            ${statusTagHtml}
            </div>
            </div>
            <div class="zmb-info">
            <div class="zmb-title" title="${displayTitle}">${displayTitle}</div>
            <div class="zmb-actions">
            <button type="button" class="zmb-btn variants-btn">
            <i class="fas fa-layer-group"></i> ${t("ZMB.BtnVariants")} (${totalScenes})
            </button>
            <button type="button" class="zmb-btn primary import-pack-btn" ${isBusy ? "disabled" : ""}>
            ${importBtnLabel}
            </button>
            </div>
            </div>
            `;

            const img = tile.querySelector("img");
            img._fallbacks = fallbacks;
            this.thumbQueue.observe(img);

            const openVariants = () => {
                this._savedScrollTop = grid.scrollTop;
                this.savedPackSearchQuery = this.searchQuery;
                this.searchQuery = "";
                this.selectedPack = pack;
                this.renderView(container);
            };

            tile.querySelector(".zmb-thumb").addEventListener("click", openVariants);
            tile.querySelector(".variants-btn").addEventListener("click", openVariants);

            const importBtn = tile.querySelector(".import-pack-btn");
            importBtn.addEventListener("click", async () => {
                await this.importPackToWorld(pack, importBtn, container);
            });

            fragment.appendChild(tile);
        }

        grid.appendChild(fragment);
    }

    renderVariantsView(container) {
        const pack = this.selectedPack;
        const displayTitle = cleanPackTitle(pack);
        const totalScenes = Array.isArray(pack.scenes) ? pack.scenes.length : (pack.sceneCount || 0);
        const isBusy = activePackImports.has(pack.moduleId);

        container.innerHTML = `
        <div class="zmb-toolbar">
        <button type="button" class="zmb-btn back-btn" style="flex: 0 0 auto;">
        <i class="fas fa-arrow-left"></i> ${t("ZMB.BtnBack")}
        </button>
        <strong style="font-size: 14px; color: #f8fafc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        ${displayTitle}
        </strong>
        <input type="text" class="zmb-search variant-search" placeholder="${t("ZMB.SearchVariantPlaceholder")}" value="${this.searchQuery}" style="max-width: 240px; margin-left: auto;">
        <button type="button" class="zmb-btn primary import-all-btn" style="flex: 0 0 auto;" ${isBusy ? "disabled" : ""}>
        <i class="fas ${isBusy ? "fa-spinner fa-spin" : "fa-cloud-download-alt"}"></i> ${t("ZMB.BtnImportAllPack", { count: totalScenes })}
        </button>
        </div>
        <div class="zmb-grid"></div>
        `;

        container.querySelector(".back-btn").addEventListener("click", () => {
            this.selectedPack = null;
            this.searchQuery = this.savedPackSearchQuery || "";
            this.renderView(container);
        });

        const importAllBtn = container.querySelector(".import-all-btn");
        importAllBtn.addEventListener("click", async () => {
            await this.importPackToWorld(pack, importAllBtn, container);
        });

        const searchInput = container.querySelector(".variant-search");
        const grid = container.querySelector(".zmb-grid");

        searchInput.addEventListener("input", (e) => {
            if (this._searchTimeout) clearTimeout(this._searchTimeout);
            this._searchTimeout = setTimeout(() => {
                this.searchQuery = e.target.value.toLowerCase().trim();
                this.populateVariantsGrid(grid, container);
            }, 120);
        });

        this.populateVariantsGrid(grid, container);
    }

    populateVariantsGrid(grid, container) {
        this.thumbQueue.disconnect();
        grid.innerHTML = "";
        const baseUrl = getServerBaseUrl();
        const pack = this.selectedPack;
        const importedMap = getImportedSceneMapForPack(pack.moduleId);

        const scenes = [...(pack.scenes || [])]
        .filter(s => !this.searchQuery || (s.name || "").toLowerCase().includes(this.searchQuery))
        .sort((a, b) => naturalCollator.compare(a.name || "", b.name || ""));

        if (scenes.length === 0) {
            grid.innerHTML = `<div class="zmb-status">${t("ZMB.NoResults")}</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();

        for (const s of scenes) {
            const candidates = getSceneThumbnailCandidates(baseUrl, pack.moduleId, s);
            const primaryThumb = candidates[0] || "icons/svg/direction.svg";
            const fallbacks = candidates.slice(1);
            const fullUrl = resolveRemoteAssetUrl(baseUrl, s.bg || s.thumb, pack.moduleId);

            const existingScene = importedMap.get(s.id);
            const isImported = Boolean(existingScene);
            const sceneKey = `${pack.moduleId}:${s.id}`;
            const isBusy = activeSceneImports.has(sceneKey);

            const tile = document.createElement("div");
            tile.className = `zmb-tile ${isImported ? "is-imported" : ""}`;
            tile.innerHTML = `
            <div class="zmb-thumb" title="${t("ZMB.BtnPreview")}">
            <img data-src="${primaryThumb}" alt="${s.name}">
            <div class="zmb-tags-top">
            <span class="zmb-tag">${s.width || "?"}×${s.height || "?"}</span>
            ${isImported ? `<span class="zmb-tag status-imported"><i class="fas fa-check"></i> ${t("ZMB.TagImported")}</span>` : ""}
            </div>
            </div>
            <div class="zmb-info">
            <div class="zmb-title" title="${s.name}">${s.name}</div>
            <div class="zmb-actions">
            ${isImported ? `
                <button type="button" class="zmb-btn open-scene-btn">
                <i class="fas fa-eye"></i> ${t("ZMB.BtnOpenScene")}
                </button>
                ` : `
                <button type="button" class="zmb-btn preview-btn">
                <i class="fas fa-search-plus"></i> ${t("ZMB.BtnPreview")}
                </button>
                `}
                <button type="button" class="zmb-btn primary import-scene-btn" ${isBusy ? "disabled" : ""}>
                <i class="fas ${isBusy ? "fa-spinner fa-spin" : (isImported ? "fa-sync-alt" : "fa-download")}"></i>
                ${isImported ? t("ZMB.BtnUpdateScene") : t("ZMB.BtnImportScene")}
                </button>
                </div>
                </div>
                `;

                const img = tile.querySelector("img");
                img._fallbacks = fallbacks;
                this.thumbQueue.observe(img);

                const previewFn = () => {
                    openImagePreview(fullUrl, `${cleanPackTitle(pack)} — ${s.name}`);
                };

                tile.querySelector(".zmb-thumb").addEventListener("click", previewFn);

                const previewBtn = tile.querySelector(".preview-btn");
                if (previewBtn) {
                    previewBtn.addEventListener("click", previewFn);
                }

                const openSceneBtn = tile.querySelector(".open-scene-btn");
                if (openSceneBtn && existingScene) {
                    openSceneBtn.addEventListener("click", () => {
                        existingScene.view();
                    });
                }

                const importBtn = tile.querySelector(".import-scene-btn");
                importBtn.addEventListener("click", async () => {
                    await this.importSingleSceneToWorld(pack, s.id, importBtn, container);
                });

                fragment.appendChild(tile);
        }

        grid.appendChild(fragment);
    }

    async importPackToWorld(pack, buttonEl, container) {
        if (activePackImports.has(pack.moduleId)) return;
        activePackImports.add(pack.moduleId);

        const baseUrl = getServerBaseUrl();
        const displayTitle = cleanPackTitle(pack);

        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i>`;
        }

        try {
            const rawScenes = await fetchPackScenesJson(baseUrl, pack.moduleId);
            const packFolder = await getOrCreatePackFolder(pack);
            const importedMap = getImportedSceneMapForPack(pack.moduleId);

            const scenesToProcess = rawScenes.filter(r => !importedMap.has(r._id || r.id));
            const targetList = scenesToProcess.length > 0 ? scenesToProcess : rawScenes;
            const isReimport = scenesToProcess.length === 0;

            ui.notifications.info(t("ZMB.NotifyDownloadingAssets", {
                title: displayTitle,
                count: targetList.length
            }));

            const scenesToCreate = [];
            const scenesToUpdate = [];
            const total = targetList.length;

            for (let i = 0; i < total; i++) {
                const raw = targetList[i];
                if (buttonEl) {
                    buttonEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${i + 1}/${total}`;
                }

                const prepared = await prepareSceneDataWithLocalAssets(raw, packFolder.id, baseUrl, pack);
                const rawId = raw._id || raw.id;

                if (isReimport && importedMap.has(rawId)) {
                    prepared._id = importedMap.get(rawId).id;
                    scenesToUpdate.push(prepared);
                } else {
                    delete prepared._id;
                    scenesToCreate.push(prepared);
                }
            }

            if (scenesToCreate.length > 0) {
                const created = await Scene.createDocuments(scenesToCreate);
                await ensureCreatedScenesHaveLevelBg(created);
            }
            if (scenesToUpdate.length > 0) {
                await Scene.updateDocuments(scenesToUpdate);
            }

            ui.notifications.info(t("ZMB.NotifyPackSuccess", {
                title: displayTitle,
                count: scenesToCreate.length + scenesToUpdate.length
            }));
        } catch (err) {
            console.error("Map Browser | Błąd importu paczki:", err);
            ui.notifications.error(t("ZMB.NotifyImportError", { message: err.message }));
        } finally {
            activePackImports.delete(pack.moduleId);
            this.refreshIfOpen();
        }
    }

    async importSingleSceneToWorld(pack, sceneId, buttonEl, container) {
        const sceneKey = `${pack.moduleId}:${sceneId}`;
        if (activeSceneImports.has(sceneKey)) return;
        activeSceneImports.add(sceneKey);

        const baseUrl = getServerBaseUrl();

        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i>`;
        }

        try {
            const rawScenes = await fetchPackScenesJson(baseUrl, pack.moduleId);
            const targetRaw = rawScenes.find(s => (s._id || s.id) === sceneId);
            if (!targetRaw) throw new Error(t("ZMB.NotifySceneNotFound"));

            ui.notifications.info(t("ZMB.NotifyDownloadingSingle", { name: targetRaw.name }));

            const packFolder = await getOrCreatePackFolder(pack);
            const sceneData = await prepareSceneDataWithLocalAssets(targetRaw, packFolder.id, baseUrl, pack);

            const importedMap = getImportedSceneMapForPack(pack.moduleId);
            const existingScene = importedMap.get(sceneId);

            if (existingScene) {
                sceneData._id = existingScene.id;
                await Scene.updateDocuments([sceneData]);
            } else {
                delete sceneData._id;
                const created = await Scene.createDocuments([sceneData]);
                await ensureCreatedScenesHaveLevelBg(created);
            }

            ui.notifications.info(t("ZMB.NotifySceneSuccess", { name: targetRaw.name }));
        } catch (err) {
            console.error("Map Browser | Błąd importu sceny:", err);
            ui.notifications.error(t("ZMB.NotifySceneError", { message: err.message }));
        } finally {
            activeSceneImports.delete(sceneKey);
            this.refreshIfOpen();
        }
    }
}

let browserInstance = null;

function openHomelabMapBrowser() {
    if (!browserInstance) {
        browserInstance = new HomelabMapBrowser();
    }
    browserInstance.render(true);
}

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "serverUrl", {
        name: "ZMB.SettingServerUrlName",
        hint: "ZMB.SettingServerUrlHint",
        scope: "world",
        config: true,
        type: String,
        default: "https://maps.zychu.org"
    });

    game.settings.register(MODULE_ID, "enableAmbilight", {
        name: "Efekt Ambient Light (YouTube Ambilight)",
                           hint: "Rozmywa kolory krawędzi mapy w miękką poświatę przechodzącą w czerń (#000000).",
                           scope: "client",
                           config: true,
                           type: Boolean,
        default: true,
            onChange: () => {
                if (canvas?.ready) renderSceneAmbilight(canvas);
            }
    });
});

// Automatycznie ustawiaj padding: 0, czarne tło #000000 i przejście 'fade' dla każdej nowo tworzonej sceny
Hooks.on("preCreateScene", (sceneDoc) => {
    const updates = {
        padding: 0,
        backgroundColor: "#000000"
    };
    if (foundry?.documents?.BaseScene?.schema?.fields?.transition) {
        updates["transition.type"] = "fade";
    }
    sceneDoc.updateSource(updates);
});

Hooks.on("canvasReady", (canvasInstance) => {
    renderSceneAmbilight(canvasInstance);
});

Hooks.on("canvasTearDown", () => {
    destroyAmbilightSprite();
});

Hooks.on("createScene", () => browserInstance?.refreshIfOpen());
Hooks.on("deleteScene", () => browserInstance?.refreshIfOpen());
Hooks.on("updateScene", (sceneDoc, changed) => {
    browserInstance?.refreshIfOpen();
    if (sceneDoc.id === canvas?.scene?.id && (changed.background || changed.levels || changed.width || changed.height)) {
        renderSceneAmbilight(canvas);
    }
});

Hooks.on("renderSceneDirectory", (app, html) => {
    if (!game.user.isGM) return;

    const root = html instanceof HTMLElement ? html : html[0];
    if (!root || root.querySelector(".zychu-map-browser-btn")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zychu-map-browser-btn";
    btn.innerHTML = `<i class="fas fa-globe"></i> ${t("ZMB.ButtonOpen")}`;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        openHomelabMapBrowser();
    });

    const headerActions = root.querySelector(".directory-header .header-actions");
    if (headerActions) {
        headerActions.appendChild(btn);
    } else {
        root.prepend(btn);
    }
});
