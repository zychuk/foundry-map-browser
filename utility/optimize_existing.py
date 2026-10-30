#!/usr/bin/env python3
"""
Naprawia i optymalizuje już istniejące moduły w /srv/data/foundry-maps/modules:
1. Szybko pomija paczki, które są już w 100% zoptymalizowane.
2. Wykrywa moduły z plikami .avif / .png (lub zepsutymi ścieżkami thumbs/),
   konwertuje je wielowątkowo do .webp (jakość 90) i przebudowuje ich scenes.json.
3. Usuwa nieużywane pliki (bazy packs/*.db, LevelDB, PDF, nieużywane obrazy) dla oszczędności miejsca.
"""

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

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


def needs_scene_rebuild(mod_dir: Path, root_dir: Path, scenes: list[dict]) -> bool:
    if not scenes:
        return True
    if list(mod_dir.rglob("*.avif")):
        return True
    for s in scenes:
        bg = extract_bg_from_raw_scene(s) or ""
        if not bg or not (root_dir / bg).is_file():
            return True
        parts = tuple(Path(bg).parts)
        if is_thumb_dir_part(parts):
            return True
    return False


def collect_referenced_files_from_valid_scenes(root_dir: Path, scenes: list[dict]) -> set[Path]:
    used: set[Path] = set()
    for s in scenes:
        bg = extract_bg_from_raw_scene(s)
        if bg and (root_dir / bg).is_file():
            used.add((root_dir / bg).resolve())
        fg = s.get("foreground")
        if isinstance(fg, str) and fg and (root_dir / fg).is_file():
            used.add((root_dir / fg).resolve())
        for key in ("tiles", "tokens"):
            for item in s.get(key) or []:
                if isinstance(item, dict):
                    src = (item.get("texture") or {}).get("src") or item.get("img")
                    if isinstance(src, str) and src and (root_dir / src).is_file():
                        used.add((root_dir / src).resolve())
        for snd in s.get("sounds") or []:
            if isinstance(snd, dict) and isinstance(snd.get("path"), str) and (root_dir / snd["path"]).is_file():
                used.add((root_dir / snd["path"]).resolve())
        for lvl in s.get("levels") or []:
            if isinstance(lvl, dict):
                lbg = (lvl.get("background") or {}).get("src")
                if isinstance(lbg, str) and lbg and (root_dir / lbg).is_file():
                    used.add((root_dir / lbg).resolve())
    return used


def optimize_module(mod_dir: Path, quality: int = 90, convert_jpg: bool = False, workers: int = 4, dry_run: bool = False) -> int:
    mod_id = mod_dir.name
    root_dir = mod_dir.parent.parent
    scenes_path = mod_dir / "scenes.json"

    current_scenes = []
    if scenes_path.is_file():
        try:
            current_scenes = json.loads(scenes_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    to_convert = [
        p for p in mod_dir.rglob("*")
        if p.is_file()
        and not is_thumb_dir_part(p.relative_to(mod_dir).parts)
        and (p.suffix.lower() in (".avif", ".png") or (convert_jpg and p.suffix.lower() in (".jpg", ".jpeg")))
    ]

    rebuild = needs_scene_rebuild(mod_dir, root_dir, current_scenes)

    # Szybka ścieżka: jeśli nie ma plików do konwersji i scenes.json jest w 100% poprawny, tylko oczyść zbędne pliki
    if not to_convert and not rebuild:
        if dry_run:
            return 0
        used_files = collect_referenced_files_from_valid_scenes(root_dir, current_scenes)
        freed = prune_unused_files_in_module(mod_dir, used_files)
        if freed > 1024 * 100:
            print(f"[OCZYSZCZONO] {mod_id}: zwolniono {freed / (1024*1024):.1f} MB zbędnych plików")
        return freed

    if rebuild and scenes_path.is_file() and (
        list(mod_dir.rglob("*.db")) or list(mod_dir.rglob("CURRENT")) or list(mod_dir.rglob("*.avif"))
    ):
        if dry_run:
            print(f"[DRY-RUN NAPRAWA] Przebudowano by sceny i skonwertowano .avif/.png w: {mod_id}")
            return 0
        scenes_path.unlink(missing_ok=True)
        raw_scenes, source_type = extract_raw_scenes_from_source(mod_dir)
    else:
        raw_scenes, source_type = current_scenes, "scenes.json"

    if dry_run:
        print(f"[DRY-RUN] {mod_id}: skonwertowano by {len(to_convert)} plików do .webp (q={quality})")
        return 0

    before_size = sum(p.stat().st_size for p in mod_dir.rglob("*") if p.is_file())

    if to_convert:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            list(pool.map(lambda p: convert_image_to_webp(p, quality=quality), to_convert))

    thumbs_dir = mod_dir / "_thumbs"
    thumbs_dir.mkdir(exist_ok=True)
    file_index = ModuleFileIndex(mod_dir)
    used_files: set[Path] = set()
    normalized_scenes = []
    thumb_tasks = []

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
            canonical_thumb = f"modules/{mod_id}/_thumbs/{thumb_name}"

            w, h = get_image_dimensions(resolved_file)
            normalize_subasset_paths(raw, file_index, mod_id, used_files)

            raw["_id"] = scene_id
            raw["width"] = int(w)
            raw["height"] = int(h)
            raw["background"] = {"src": canonical_bg}
            raw["thumb"] = canonical_bg
            raw.pop("img", None)
            normalized_scenes.append(raw)
            thumb_tasks.append((raw, resolved_file, thumb_file, canonical_thumb, canonical_bg))

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
            canonical_thumb = f"modules/{mod_id}/_thumbs/{thumb_name}"
            clean_name = img_src.stem.replace("_", " ").replace("-", " ").strip()
            scene_doc = {
                "_id": deterministic_foundry_id(f"{mod_id}:{rel_file}"),
                "name": clean_name,
                "width": int(w),
                "height": int(h),
                "grid": {"size": 100, "type": 1, "distance": 5, "units": "ft"},
                "background": {"src": canonical_bg},
                "thumb": canonical_bg,
                "walls": [],
                "lights": [],
                "tiles": []
            }
            normalized_scenes.append(scene_doc)
            thumb_tasks.append((scene_doc, img_src, thumb_file, canonical_thumb, canonical_bg))

    if normalized_scenes:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = [
                (scene_doc, canonical_thumb, canonical_bg, pool.submit(generate_webp_thumbnail, src_img, t_file))
                for scene_doc, src_img, t_file, canonical_thumb, canonical_bg in thumb_tasks
            ]
            for scene_doc, canonical_thumb, canonical_bg, fut in futures:
                scene_doc["thumb"] = canonical_thumb if fut.result() else canonical_bg

        scenes_path.write_text(json.dumps(normalized_scenes, ensure_ascii=False, indent=2), encoding="utf-8")
        prune_unused_files_in_module(mod_dir, used_files)

    after_size = sum(p.stat().st_size for p in mod_dir.rglob("*") if p.is_file())
    saved = max(0, before_size - after_size)
    print(f"[ZOPTYMALIZOWANO] {mod_id}: scen={len(normalized_scenes)}, zaoszczędzono={saved / (1024*1024):.1f} MB")
    return saved


def main():
    parser = argparse.ArgumentParser(description="Optymalizuje i naprawia istniejące moduły w modules/.")
    parser.add_argument("--modules-dir", "-m", default="/srv/data/foundry-maps/modules", help="Ścieżka do katalogu modules/.")
    parser.add_argument("--quality", "-q", type=int, default=90, help="Jakość konwersji WebP (domyślnie: 90).")
    parser.add_argument("--convert-jpg", action="store_true", help="Konwertuj również pliki .jpg do .webp.")
    parser.add_argument("--workers", "-w", type=int, default=min(8, os.cpu_count() or 4), help="Liczba wątków.")
    parser.add_argument("--dry-run", action="store_true", help="Tylko pokaż co zostanie zrobione.")
    args = parser.parse_args()

    mods_root = Path(args.modules_dir).resolve()
    total_saved = 0
    for mod_dir in sorted([d for d in mods_root.iterdir() if d.is_dir() and not d.name.startswith(".")]):
        total_saved += optimize_module(
            mod_dir,
            quality=args.quality,
            convert_jpg=args.convert_jpg,
            workers=args.workers,
            dry_run=args.dry_run,
        )

    print(f"\n[GOTOWE] Łącznie zwolniono miejsca: {total_saved / (1024*1024):.1f} MB ({total_saved / (1024*1024*1024):.2f} GB)")


if __name__ == "__main__":
    main()
