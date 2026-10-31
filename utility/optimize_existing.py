#!/usr/bin/env python3
"""
Naprawia i optymalizuje istniejące moduły (działa poprawnie dla dowolnej nazwy folderu np. ./server_modules):
- Konwertuje wszystkie .avif, .png oraz .jpg/.jpeg do .webp (z adaptacyjnym zejściem jakości dla mocno skompresowanych .jpg).
- Odchudza przerośnięte pliki .webp > 3.5 MB.
- Aktualizuje ścieżki w scenes.json i usuwa zbędne pliki.
"""

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from normalize_module import (
    BIG_WEBP_THRESHOLD,
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


def resolve_mod_relative_path(mod_dir: Path, raw_path: str | None) -> Path | None:
    if not raw_path or not isinstance(raw_path, str):
        return None
    parts = list(Path(raw_path.strip().lstrip("/")).parts)
    if len(parts) >= 2 and parts[0].lower() == "modules":
        parts = parts[2:]
    if not parts:
        return None
    cand = mod_dir.joinpath(*parts)
    return cand if cand.is_file() else None


def needs_scene_rebuild(mod_dir: Path, scenes: list[dict]) -> bool:
    if not scenes:
        return True
    if list(mod_dir.rglob("*.avif")):
        return True
    for s in scenes:
        bg = extract_bg_from_raw_scene(s) or ""
        resolved = resolve_mod_relative_path(mod_dir, bg)
        if not resolved:
            return True
        if is_thumb_dir_part(resolved.relative_to(mod_dir).parts):
            return True
    return False


def collect_referenced_files_from_valid_scenes(mod_dir: Path, scenes: list[dict]) -> set[Path]:
    used: set[Path] = set()
    for s in scenes:
        bg_file = resolve_mod_relative_path(mod_dir, extract_bg_from_raw_scene(s))
        if bg_file:
            used.add(bg_file.resolve())
        fg_file = resolve_mod_relative_path(mod_dir, s.get("foreground"))
        if fg_file:
            used.add(fg_file.resolve())
        for key in ("tiles", "tokens"):
            for item in s.get(key) or []:
                if isinstance(item, dict):
                    src = (item.get("texture") or {}).get("src") or item.get("img")
                    f = resolve_mod_relative_path(mod_dir, src)
                    if f:
                        used.add(f.resolve())
        for snd in s.get("sounds") or []:
            if isinstance(snd, dict):
                f = resolve_mod_relative_path(mod_dir, snd.get("path"))
                if f:
                    used.add(f.resolve())
        for lvl in s.get("levels") or []:
            if isinstance(lvl, dict):
                lbg = (lvl.get("background") or {}).get("src")
                f = resolve_mod_relative_path(mod_dir, lbg)
                if f:
                    used.add(f.resolve())
    return used


def optimize_module(
    mod_dir: Path,
    quality: int = 85,
    convert_jpg: bool = True,
    shrink_big_webp: bool = True,
    workers: int = 8,
    dry_run: bool = False,
) -> int:
    mod_id = mod_dir.name
    scenes_path = mod_dir / "scenes.json"

    current_scenes = []
    if scenes_path.is_file():
        try:
            current_scenes = json.loads(scenes_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    to_convert = []
    for p in mod_dir.rglob("*"):
        if not p.is_file() or is_thumb_dir_part(p.relative_to(mod_dir).parts):
            continue
        ext = p.suffix.lower()
        if ext in (".avif", ".png"):
            to_convert.append(p)
        elif convert_jpg and ext in (".jpg", ".jpeg"):
            to_convert.append(p)
        elif shrink_big_webp and ext == ".webp" and p.stat().st_size > BIG_WEBP_THRESHOLD:
            to_convert.append(p)

    rebuild = needs_scene_rebuild(mod_dir, current_scenes)

    if not to_convert and not rebuild:
        if dry_run:
            return 0
        used_files = collect_referenced_files_from_valid_scenes(mod_dir, current_scenes)
        freed = prune_unused_files_in_module(mod_dir, used_files)
        if freed > 1024 * 100:
            print(f"[OCZYSZCZONO] {mod_id}: zwolniono {freed / (1024*1024):.1f} MB zbędnych plików")
        return freed

    if rebuild and scenes_path.is_file() and (
        list(mod_dir.rglob("*.db")) or list(mod_dir.rglob("CURRENT")) or list(mod_dir.rglob("*.avif"))
    ):
        if dry_run:
            print(f"[DRY-RUN NAPRAWA] Przebudowano by sceny w: {mod_id}")
            return 0
        scenes_path.unlink(missing_ok=True)
        raw_scenes, source_type = extract_raw_scenes_from_source(mod_dir)
    else:
        raw_scenes, source_type = current_scenes, "scenes.json"

    if dry_run:
        print(f"[DRY-RUN] {mod_id}: zoptymalizowano by {len(to_convert)} plików (q={quality})")
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
    if saved > 1024 * 50:
        print(f"[ZOPTYMALIZOWANO] {mod_id}: scen={len(normalized_scenes)}, zaoszczędzono={saved / (1024*1024):.1f} MB")
    return saved


def main():
    parser = argparse.ArgumentParser(description="Kompletna optymalizacja modułów.")
    parser.add_argument("--modules-dir", "-m", default="./server_modules", help="Ścieżka do katalogu z modułami.")
    parser.add_argument("--quality", "-q", type=int, default=85, help="Docelowa jakość WebP (domyślnie: 85).")
    parser.add_argument("--convert-jpg", action="store_true", default=True, help="Konwertuj .jpg/.jpeg do .webp.")
    parser.add_argument("--shrink-big-webp", action="store_true", default=True, help="Odchudź ciężkie pliki .webp (>3.5 MB).")
    parser.add_argument("--workers", "-w", type=int, default=min(12, os.cpu_count() or 4), help="Liczba wątków.")
    parser.add_argument("--dry-run", action="store_true", help="Tylko pokaż co zostanie zrobione.")
    args = parser.parse_args()

    mods_root = Path(args.modules_dir).resolve()
    mod_dirs = sorted([d for d in mods_root.iterdir() if d.is_dir() and not d.name.startswith(".")])
    total_saved = 0

    print(f"[START] Optymalizacja {len(mod_dirs)} paczek w {mods_root} (wątki: {args.workers})...")
    for idx, mod_dir in enumerate(mod_dirs, 1):
        saved = optimize_module(
            mod_dir,
            quality=args.quality,
            convert_jpg=args.convert_jpg,
            shrink_big_webp=args.shrink_big_webp,
            workers=args.workers,
            dry_run=args.dry_run,
        )
        total_saved += saved

    print(f"\n[GOTOWE] Łącznie zwolniono miejsca: {total_saved / (1024*1024):.1f} MB ({total_saved / (1024*1024*1024):.2f} GB)")


if __name__ == "__main__":
    main()
