import { MODULE_ID, delay } from "./constants.js";

let currentAmbilightSprite = null;
let ambilightGeneration = 0;

/**
 * Unieważnia trwające ładowanie tła i usuwa poświatę Ambilight z płótna PIXI.
 */
export function cancelAmbilightRender() {
    ambilightGeneration++;
    destroyAmbilightSprite();
}

export function destroyAmbilightSprite() {
    if (currentAmbilightSprite) {
        try {
            currentAmbilightSprite.parent?.removeChild(currentAmbilightSprite);
            currentAmbilightSprite.destroy({ children: true, texture: true, baseTexture: true });
        } catch {
            // Ignoruj błędy przy zamykaniu sceny
        }
        currentAmbilightSprite = null;
    }

    const containers = [canvas?.environment, canvas?.primary?.parent, canvas?.primary, canvas?.stage];
    for (const container of containers) {
        if (!container?.children?.length) continue;
        for (let i = container.children.length - 1; i >= 0; i--) {
            const ch = container.children[i];
            if (ch?._isZmbAmbilight) {
                try {
                    container.removeChildAt(i);
                    ch.destroy({ children: true, texture: true, baseTexture: true });
                } catch {
                    // Ignoruj błędy przy czyszczeniu kontenera
                }
            }
        }
    }
}

async function loadMediaElementForAmbilight(canvasInstance, bgSrc) {
    const isVideo = /\.(webm|mp4|m4v|ogv)(\?|$)/i.test(bgSrc);

    if (isVideo) {
        const existingSource =
            canvasInstance.primary?.background?.texture?.baseTexture?.resource?.source ||
            canvasInstance.primary?.background?.texture?.source?.resource;

        if (existingSource && typeof HTMLVideoElement !== "undefined" && existingSource instanceof HTMLVideoElement) {
            if (existingSource.readyState < 2) {
                await new Promise((resolve) => {
                    const done = () => resolve();
                    existingSource.addEventListener("loadeddata", done, { once: true });
                    existingSource.addEventListener("canplay", done, { once: true });
                    setTimeout(done, 2500);
                });
            }
            if (existingSource.currentTime < 0.05) await delay(120);
            if (existingSource.videoWidth > 0) return existingSource;
        }

        return await new Promise((resolve) => {
            const vid = document.createElement("video");
            vid.crossOrigin = "anonymous";
            vid.muted = true;
            vid.playsInline = true;
            vid.preload = "auto";

            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };

            const timeoutId = setTimeout(() => finish(vid.videoWidth > 0 ? vid : null), 4000);
            vid.addEventListener("loadeddata", () => {
                if (vid.duration > 0.2) vid.currentTime = 0.2;
                else {
                    clearTimeout(timeoutId);
                    finish(vid);
                }
            }, { once: true });
            vid.addEventListener("seeked", () => {
                clearTimeout(timeoutId);
                finish(vid);
            }, { once: true });
            vid.addEventListener("error", () => {
                clearTimeout(timeoutId);
                finish(null);
            }, { once: true });

            vid.src = bgSrc;
            vid.load();
        });
    }

    const img = new Image();
    img.crossOrigin = "anonymous";
    const loaded = await new Promise((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = bgSrc;
    });
    return loaded ? img : null;
}

export async function renderSceneAmbilight(canvasInstance) {
    const myGen = ++ambilightGeneration;
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

        if (!bgSrc) return;

        const mediaEl = await loadMediaElementForAmbilight(canvasInstance, bgSrc);
        if (!mediaEl || myGen !== ambilightGeneration || !canvasInstance.ready) {
            if (mediaEl && typeof HTMLVideoElement !== "undefined" && mediaEl instanceof HTMLVideoElement && !mediaEl.parentElement) {
                mediaEl.removeAttribute("src");
                mediaEl.load();
            }
            return;
        }

        destroyAmbilightSprite();

        const aspect = sr.width / sr.height;
        const BASE_INNER = 360;
        const innerW = aspect >= 1 ? BASE_INNER : Math.max(120, Math.round(BASE_INNER * aspect));
        const innerH = aspect >= 1 ? Math.max(120, Math.round(BASE_INNER / aspect)) : BASE_INNER;
        const MARGIN = 110;
        const canvasW = innerW + MARGIN * 2;
        const canvasH = innerH + MARGIN * 2;

        const offCanvas = document.createElement("canvas");
        offCanvas.width = canvasW;
        offCanvas.height = canvasH;
        const ctx = offCanvas.getContext("2d");

        ctx.save();
        ctx.filter = "blur(42px) saturate(1.9) brightness(1.08)";
        ctx.drawImage(mediaEl, MARGIN - 16, MARGIN - 16, innerW + 32, innerH + 32);
        ctx.restore();

        ctx.save();
        ctx.filter = "blur(20px) saturate(1.75) brightness(1.05)";
        ctx.drawImage(mediaEl, MARGIN - 16, MARGIN - 16, innerW + 32, innerH + 32);
        ctx.restore();

        const existingSource =
            canvasInstance.primary?.background?.texture?.baseTexture?.resource?.source ||
            canvasInstance.primary?.background?.texture?.source?.resource;
        if (mediaEl !== existingSource && typeof HTMLVideoElement !== "undefined" && mediaEl instanceof HTMLVideoElement) {
            mediaEl.removeAttribute("src");
            mediaEl.load();
        }

        const tex = PIXI.Texture.from(offCanvas);
        const sprite = new PIXI.Sprite(tex);
        sprite._isZmbAmbilight = true;

        const padX = sr.width * (MARGIN / innerW);
        const padY = sr.height * (MARGIN / innerH);

        sprite.x = sr.x - padX;
        sprite.y = sr.y - padY;
        sprite.width = sr.width + padX * 2;
        sprite.height = sr.height + padY * 2;
        sprite.alpha = 1.0;
        sprite.eventMode = "none";
        sprite.interactiveChildren = false;

        const envContainer = canvasInstance.environment || canvasInstance.primary?.parent;
        if (envContainer) {
            envContainer.addChildAt(sprite, 0);
            currentAmbilightSprite = sprite;
        }
    } catch (err) {
        console.warn(`[${MODULE_ID}] Ambilight render warning:`, err);
    }
}