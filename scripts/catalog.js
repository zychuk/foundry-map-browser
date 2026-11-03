import { MODULE_ID, naturalCollator } from "./constants.js";

let catalogCache = null;
const scenesJsonCache = new Map();

export function getCatalogCache() {
    return catalogCache;
}

export function clearCatalogCaches() {
    catalogCache = null;
    scenesJsonCache.clear();
}

export function openImagePreview(src, title) {
    if (!src) return;
    const AppV2Popout = foundry.applications?.apps?.ImagePopout;
    const AppV2Base = foundry.applications?.api?.ApplicationV2;
    if (AppV2Popout && AppV2Base && AppV2Popout.prototype instanceof AppV2Base) {
        new AppV2Popout({ src, window: { title } }).render({ force: true });
    } else if (typeof ImagePopout !== "undefined") {
        new ImagePopout(src, { title }).render(true);
    }
}

export function getServerUrl() {
    const raw = game.settings.get(MODULE_ID, "serverUrl") || "";
    return raw.trim().replace(/\/+$/, "");
}

export function getCleanPackTitle(pack) {
    if (pack._cleanTitle) return pack._cleanTitle;
    return (pack.title || pack.moduleId || "")
        .replace(/^(Cze and Peku\s*-\s*|Czepeku Scenes\s*-\s*|Czepeku\s*-\s*)/i, "")
        .trim();
}

export function getSortKey(pack) {
    if (pack._sortKey) return pack._sortKey;
    return getCleanPackTitle(pack).replace(/^\d+\s*[-–.]*\s*/, "").trim();
}

export function buildRemoteUrl(baseUrl, relativePath) {
    if (!relativePath || typeof relativePath !== "string") return "";
    const trimmed = relativePath.trim();
    if (!trimmed) return "";
    if (
        trimmed.startsWith("http://") ||
        trimmed.startsWith("https://") ||
        trimmed.startsWith("data:") ||
        trimmed.startsWith("icons/") ||
        trimmed.startsWith("ui/")
    ) {
        return trimmed;
    }

    const clean = trimmed.replace(/^\/+/, "");
    const encoded = clean
        .split("/")
        .map(segment => {
            try { return encodeURIComponent(decodeURIComponent(segment)); }
            catch { return encodeURIComponent(segment); }
        })
        .join("/");
    return `${baseUrl}/${encoded}`;
}

export function resolveAssetUrl(baseUrl, assetPath, moduleId) {
    if (!assetPath || typeof assetPath !== "string") return "";
    const trimmed = assetPath.trim();
    if (!trimmed) return "";
    if (
        trimmed.startsWith("http://") ||
        trimmed.startsWith("https://") ||
        trimmed.startsWith("data:") ||
        trimmed.startsWith("icons/") ||
        trimmed.startsWith("ui/")
    ) {
        return trimmed;
    }

    const clean = trimmed.replace(/^\/+/, "");
    if (clean.startsWith("thumbs/")) {
        return buildRemoteUrl(baseUrl, clean);
    }
    if (clean.startsWith("modules/")) {
        const parts = clean.split("/");
        if (moduleId && parts.length > 2) parts[1] = moduleId;
        return buildRemoteUrl(baseUrl, parts.join("/"));
    }
    return buildRemoteUrl(baseUrl, `modules/${moduleId}/${clean}`);
}

export function getPackTotalCount(pack) {
    if (Array.isArray(pack.scenes)) return pack.scenes.length;
    return Number(pack.sceneCount) || 0;
}

export function getPackCoverCandidates(baseUrl, pack) {
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
    if (pack.cover) addCandidate(pack.cover);
    if (Array.isArray(pack.scenes)) {
        for (const s of pack.scenes) addCandidate(s.thumb);
        for (const s of pack.scenes) addCandidate(s.bg);
    }
    return candidates;
}

export function getSceneThumbCandidates(baseUrl, pack, sceneMeta) {
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
        pack._safeTitle = foundry.utils.escapeHTML(pack._cleanTitle);
        pack._versionStr = foundry.utils.escapeHTML(pack.version ? `v${pack.version}` : "v1.0");
        pack._sortKey = getSortKey(pack);
        const sceneNames = Array.isArray(pack.scenes) ? pack.scenes.map(s => s.name || "").join(" ") : "";
        pack._searchBlob = `${pack._cleanTitle} ${pack.title || ""} ${pack.moduleId || ""} ${sceneNames}`.toLowerCase();
    }
    catalog.packs.sort((a, b) => {
        const cmp = naturalCollator.compare(a._sortKey, b._sortKey);
        if (cmp !== 0) return cmp;
        return naturalCollator.compare(a._cleanTitle, b._cleanTitle);
    });
    return catalog;
}

export async function loadCatalog(force = false) {
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

export async function loadPackScenesJson(baseUrl, moduleId) {
    if (scenesJsonCache.has(moduleId)) return scenesJsonCache.get(moduleId);
    const scenesUrl = `${baseUrl}/modules/${encodeURIComponent(moduleId)}/scenes.json`;
    const res = await fetch(scenesUrl);
    if (!res.ok) {
        throw new Error(game.i18n.format("ZMB.CatalogError", { status: res.status }));
    }
    const rawScenes = await res.json();
    scenesJsonCache.set(moduleId, rawScenes);
    return rawScenes;
}

export function buildWorldSceneIndex() {
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

export function findWorldScene(worldIndex, moduleId, sceneId) {
    return worldIndex.get(`${moduleId}:${sceneId}`);
}

export function getPackStatus(pack, worldIndex) {
    const scenes = Array.isArray(pack.scenes) ? pack.scenes : [];
    let importedCount = 0;
    for (const s of scenes) {
        if (findWorldScene(worldIndex, pack.moduleId, s.id)) importedCount++;
    }
    const totalCount = getPackTotalCount(pack);
    return {
        importedCount,
        totalCount,
        isImported: importedCount > 0,
        isFullyImported: totalCount > 0 && importedCount >= totalCount
    };
}