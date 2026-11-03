export const MODULE_ID = "zychu-map-browser";
export const ROOT_SCENE_FOLDER = "Zychu Maps";
export const FALLBACK_THUMB = "icons/svg/direction.svg";
export const ZMB_CHUNK_SIZE = 36;

export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const naturalCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base"
});