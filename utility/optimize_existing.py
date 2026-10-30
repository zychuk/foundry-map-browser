#!/usr/bin/env python3
"""
Naprawia i optymalizuje już istniejące moduły w /srv/data/foundry-maps/modules:
1. Wykrywa moduły, które miały pliki .avif (lub wskazania na stare miniatury thumbs/),
   konwertuje mapy .avif i .png do .webp (jakość 90) i przebudowuje ich scenes.json.
2. Usuwa nieużywane pliki (bazy packs/*.db, LevelDB, PDF, nieużywane obrazy) dla oszczędności miejsca.
"""

import argparse
import json
from pathlib import Path

# Wymaga normalize_module.py w tym samym folderze
from normalize_module import (
    IMAGE_EXTS,
    ModuleFileIndex,
    build_thumb_filename,
    convert_image_to_webp,
    deterministic_foundry_id,
    extract_bg_from_raw_scene,
    extract_raw_scenes_from_source,
    generate_webp_thumbnail,
    get_image_dimensions,
    is_thumb_dir_part,
    normalize_subasset_paths,
    prune_unused_files_in_module,
)


def needs_scene_rebuild(mod_dir: Path, scenes: list[dict]) -> bool:
    if not scenes:
        return True
    if list(mod_dir.rglob("*.avif")):
        return True
    for s in scenes:
        bg = extract_bg_from_raw_scene(s) or ""
        parts = tuple(Path(bg).parts)
        if is_thumb_dir_part(parts):
            return True
    return False


def optimize_module(mod_dir: Path, quality: int = 90, convert_jpg: bool = False, dry_run: bool = False) -> int:
    mod_id = mod_dir.name
    scenes_path = mod_dir / "scenes.json"

    current_scenes = []
    if scenes_path.is_file():
        try:
            current_scenes = json.loads(scenes_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    rebuild = needs_scene_rebuild(mod_dir, current_scenes)

    if rebuild and scenes_path.is_file() and (
        list(mod_dir.rglob("*.db")) or list(mod_dir.rglob("CURRENT")) or list(mod_dir.rglob("*.avif"))
    ):
        if dry_run:
            print(f"[DRY-RUN NAPRAWA] Przebudowano by sceny i skonwertowano .avif w: {mod_id}")
            return 0
        scenes_path.unlink(missing_ok=True)
        raw_scenes, source_type = extract_raw_scenes_from_source(mod_dir)
    else:
        raw_scenes, source_type = current_scenes, "scenes.json"

    if dry_run:
        to_conv = [
            p for p in mod_dir.rglob("*")
            if p.is_file() and not is_thumb_dir_part(p.relative_to(mod_dir).parts)
            and (p.suffix.lower() in (".avif", ".png") or (convert_jpg and p.suffix.lower() in (".jpg", ".jpeg")))
        ]
        if to_conv:
            print(f"[DRY-RUN] {mod_id}: skonwertowano by {len(to_conv)} plików do .webp (q={quality})")
        return 0

    before_size = sum(p.stat().st_size for p in mod_dir.rglob("*") if p.is_file())

    for p in list(mod_dir.rglob("*")):
        if not p.is_file() or is_thumb_dir_part(p.relative_to(mod_dir).parts):
            continue
        if p.suffix.lower() in (".avif", ".png") or (convert_jpg and p.suffix.lower() in (".jpg", ".jpeg")):
            convert_image_to_webp(p, quality=quality)

    thumbs_dir = mod_dir / "_thumbs"
    thumbs_dir.mkdir(exist_ok=True)
    file_index = ModuleFileIndex(mod_dir)
    used_files: set[Path] = set()
    normalized_scenes = []

    if source_type and raw_scenes:
        for raw in raw_scenes:
            bg_raw = extract_bg_from_raw_scene(raw)
            resolved_file = file_index.resolve(bg_raw)
            if not resolved_file:
                continue
            used_files.add(resolved_file.resolve())
            rel_file = resolved_file.relative_to(mod_dir).as_posix()
            scene_id = raw.get("_id") or deterministic_foundry_id(f"{mod_id}:{rel_file}")
            canonical_bg = f"modules/{mod_id}/{rel_file}"

            thumb_name = build_thumb_filename(rel_file, resolved_file.stem)
            thumb_file = thumbs_dir / thumb_name
            canonical_thumb = (
                f"modules/{mod_id}/_thumbs/{thumb_name}"
                if generate_webp_thumbnail(resolved_file, thumb_file)
                else canonical_bg
            )

            w, h = get_image_dimensions(resolved_file)
            normalize_subasset_paths(raw, file_index, mod_id, used_files)

            raw["_id"] = scene_id
            raw["width"] = int(w)
            raw["height"] = int(h)
            raw["background"] = {"src": canonical_bg}
            raw["thumb"] = canonical_thumb
            raw.pop("img", None)
            normalized_scenes.append(raw)

    if not normalized_scenes:
        all_images = sorted([
            p for p in mod_dir.rglob("*")
            if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not is_thumb_dir_part(p.relative_to(mod_dir).parts)
        ])
        for img_src in all_images:
            used_files.add(img_src.resolve())
            rel_file = img_src.relative_to(mod_dir).as_posix()
            canonical_bg = f"modules/{mod_id}/{rel_file}"
            w, h = get_image_dimensions(img_src)
            thumb_name = build_thumb_filename(rel_file, img_src.stem)
            thumb_file = thumbs_dir / thumb_name
            canonical_thumb = (
                f"modules/{mod_id}/_thumbs/{thumb_name}"
                if generate_webp_thumbnail(img_src, thumb_file)
                else canonical_bg
            )
            clean_name = img_src.stem.replace("_", " ").replace("-", " ").strip()
            normalized_scenes.append({
                "_id": deterministic_foundry_id(f"{mod_id}:{rel_file}"),
                "name": clean_name,
                "width": int(w),
                "height": int(h),
                "grid": {"size": 100, "type": 1, "distance": 5, "units": "ft"},
                "background": {"src": canonical_bg},
                "thumb": canonical_thumb,
                "walls": [],
                "lights": [],
                "tiles": []
            })

    if normalized_scenes:
        scenes_path.write_text(json.dumps(normalized_scenes, ensure_ascii=False, indent=2), encoding="utf-8")
        prune_unused_files_in_module(mod_dir, used_files)

    after_size = sum(p.stat().st_size for p in mod_dir.rglob("*") if p.is_file())
    saved = max(0, before_size - after_size)
    if saved > 1024 * 100 or rebuild:
        print(f"[ZOPTYMALIZOWANO] {mod_id}: scen={len(normalized_scenes)}, zaoszczędzono={saved / (1024*1024):.1f} MB")
    return saved


def main():
    parser = argparse.ArgumentParser(description="Optymalizuje i naprawia istniejące moduły w modules/.")
    parser.add_argument("--modules-dir", "-m", default="/srv/data/foundry-maps/modules", help="Ścieżka do katalogu modules/.")
    parser.add_argument("--quality", "-q", type=int, default=90, help="Jakość konwersji WebP (domyślnie: 90).")
    parser.add_argument("--convert-jpg", action="store_true", help="Konwertuj również pliki .jpg do .webp.")
    parser.add_argument("--dry-run", action="store_true", help="Tylko pokaż co zostanie zrobione.")
    args = parser.parse_args()

    mods_root = Path(args.modules_dir).resolve()
    total_saved = 0
    for mod_dir in sorted([d for d in mods_root.iterdir() if d.is_dir() and not d.name.startswith(".")]):
        total_saved += optimize_module(mod_dir, quality=args.quality, convert_jpg=args.convert_jpg, dry_run=args.dry_run)

    print(f"\n[GOTOWE] Łącznie zwolniono miejsca: {total_saved / (1024*1024):.1f} MB ({total_saved / (1024*1024*1024):.2f} GB)")


if __name__ == "__main__":
    main()