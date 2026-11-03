import { MODULE_ID } from "./constants.js";
import { cancelAmbilightRender, renderSceneAmbilight } from "./ambilight.js";
import { clearCatalogCaches } from "./catalog.js";
import { clearImporterCaches, isBulkImporting } from "./importer.js";
import { HomelabMapBrowser } from "./browser-app.js";

let browserInstance = null;

function resetCachesOnUrlChange() {
    clearCatalogCaches();
    clearImporterCaches();
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

    game.settings.register(MODULE_ID, "enableAmbilight", {
        name: "ZMB.EnableAmbilightName",
        hint: "ZMB.EnableAmbilightHint",
        scope: "client",
        config: true,
        type: Boolean,
        default: false,
        onChange: () => {
            if (canvas?.ready) renderSceneAmbilight(canvas);
        }
    });

    game.settings.register(MODULE_ID, "enforceSceneDefaults", {
        name: "ZMB.EnforceSceneDefaultsName",
        hint: "ZMB.EnforceSceneDefaultsHint",
        scope: "world",
        config: true,
        type: Boolean,
        default: false
    });
});

Hooks.on("preCreateScene", (sceneDoc) => {
    if (!game.settings.get(MODULE_ID, "enforceSceneDefaults")) return;
    const updates = {
        padding: 0,
        backgroundColor: "#000000"
    };
    if (Scene.schema?.fields?.transition) {
        updates.transition = { type: "fade" };
    }
    sceneDoc.updateSource(updates);
});

Hooks.on("canvasInit", () => {
    cancelAmbilightRender();
});

Hooks.on("canvasReady", (canvasInstance) => {
    renderSceneAmbilight(canvasInstance);
});

Hooks.on("canvasTearDown", () => {
    cancelAmbilightRender();
});

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
    if (browserInstance?.rendered && !isBulkImporting) {
        browserInstance.refreshGridOnly({ preserveScroll: true });
    }
});

Hooks.on("deleteScene", (scene) => {
    if (!scene?.getFlag?.(MODULE_ID, "moduleId")) return;
    if (browserInstance?.rendered && !isBulkImporting) {
        browserInstance.refreshGridOnly({ preserveScroll: true });
    }
});

Hooks.on("updateScene", (sceneDoc, changed) => {
    if (sceneDoc.id === canvas?.scene?.id && (changed.background || changed.levels || changed.width || changed.height || changed.padding !== undefined)) {
        renderSceneAmbilight(canvas);
    }
});