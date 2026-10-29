#!/usr/bin/env python3
"""
Skanuje /srv/data/foundry-maps/art/ (rekursywnie),
generuje miniatury .webp wielowątkowo z BIAŁYM tłem pod przezroczystymi PNG/WebP,
oraz zapisuje art_catalog.json.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = None
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False

MEDIA_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm"}
VIDEO_EXTS = {".mp4", ".webm"}


def format_category_name(rel_folder_path: str) -> str:
    if rel_folder_path in ("", "."):
        return "General"
    parts = Path(rel_folder_path).parts
    clean_parts = [p.replace("_", " ").replace("-", " ").strip() for p in parts]
    return " / ".join(clean_parts) if clean_parts else "General"


def make_thumb(src: Path, dest: Path, dry_run: bool = False) -> str:
    """Zwraca 'cached', 'created' lub 'failed'."""
    if dest.is_file() and dest.stat().st_size > 0 and dest.stat().st_mtime >= src.stat().st_mtime:
        return "cached"

    if dry_run:
        return "created"

    dest.parent.mkdir(parents=True, exist_ok=True)
    ext = src.suffix.lower()

    # 1. Metoda główna: Pillow (kompleksowa obsługa trybów RGBA, P, L, CMYK i orientacji EXIF)
    if ext not in VIDEO_EXTS and HAS_PILLOW:
        try:
            with Image.open(src) as im:
                im = ImageOps.exif_transpose(im)
                if im.mode != "RGBA":
                    im = im.convert("RGBA")

                bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
                combined = Image.alpha_composite(bg, im).convert("RGB")
                combined.thumbnail((480, 480), Image.Resampling.LANCZOS)
                combined.save(dest, "WEBP", quality=80)
                return "created"
        except Exception as e:
            print(f"[!] Błąd Pillow dla {src.name}: {e}", file=sys.stderr)

    # 2. Fallback: ffmpeg (z zachowaniem proporcji obrazu i białym tłem pod przezroczystością)
    if shutil.which("ffmpeg"):
        cmd = ["ffmpeg", "-y", "-v", "error"]
        if ext in VIDEO_EXTS:
            cmd += ["-ss", "00:00:00.500"]
        cmd += [
            "-i", str(src),
            "-frames:v", "1",
            "-filter_complex",
            "[0:v]scale=480:480:force_original_aspect_ratio=decrease[fg];"
            "color=white[bg];[bg][fg]scale2ref[bg2][fg2];"
            "[bg2][fg2]overlay=shortest=1",
            "-q:v", "75",
            str(dest)
        ]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode == 0 and dest.is_file() and dest.stat().st_size > 0:
            return "created"

    # 3. Fallback: cwebp
    if ext not in VIDEO_EXTS and ext != ".gif" and shutil.which("cwebp"):
        res = subprocess.run(
            ["cwebp", "-quiet", "-resize", "480", "0", "-q", "80", str(src), "-o", str(dest)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if res.returncode == 0 and dest.is_file() and dest.stat().st_size > 0:
            return "created"

    return "failed"


def main():
    parser = argparse.ArgumentParser(description="Buduje art_catalog.json z podfolderów w art/.")
    parser.add_argument("--root", "-r", default="/srv/data/foundry-maps", help="Główny katalog serwera.")
    parser.add_argument(
        "--workers",
        "-w",
        type=int,
        default=min(8, os.cpu_count() or 4),
        help="Liczba wątków generowania miniatur (domyślnie: min(8, liczba rdzeni)).",
    )
    parser.add_argument("--clean-orphans", action="store_true", help="Usuń osierocone miniatury z art/_thumbs/.")
    parser.add_argument("--dry-run", action="store_true", help="Pokaż podsumowanie bez zapisywania zmian.")
    args = parser.parse_args()

    root_dir = Path(args.root).resolve()
    art_dir = root_dir / "art"
    art_dir.mkdir(parents=True, exist_ok=True)
    thumbs_root = art_dir / "_thumbs"

    all_dirs_with_files = set()
    for p in art_dir.rglob("*"):
        if p.is_file() and p.suffix.lower() in MEDIA_EXTS and "_thumbs" not in p.parts:
            all_dirs_with_files.add(p.parent)

    sorted_dirs = sorted(list(all_dirs_with_files))
    folders_data = []
    thumbs_created = 0
    thumbs_cached = 0
    active_thumb_paths = set()

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for folder in sorted_dirs:
            rel_folder = folder.relative_to(art_dir).as_posix()
            cat_id = "general" if rel_folder == "." else rel_folder.lower().replace("/", "__").replace(" ", "-").replace("_", "-")
            cat_name = format_category_name(rel_folder)

            files = sorted([f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in MEDIA_EXTS])
            if not files:
                continue

            pending_items = []
            for f in files:
                rel_path = f.relative_to(root_dir).as_posix()
                short_hash = hashlib.md5(rel_path.encode("utf-8")).hexdigest()[:10]
                thumb_file = (
                    (thumbs_root / f"{f.stem}_{short_hash}.webp")
                    if rel_folder == "."
                    else (thumbs_root / rel_folder / f"{f.stem}_{short_hash}.webp")
                )
                fut = pool.submit(make_thumb, f, thumb_file, args.dry_run)
                pending_items.append((f, rel_path, thumb_file, fut))

            items = []
            for f, rel_path, thumb_file, fut in pending_items:
                status = fut.result()
                if status in ("created", "cached"):
                    thumb_rel = thumb_file.relative_to(root_dir).as_posix()
                    active_thumb_paths.add(thumb_file.resolve())
                    if status == "created":
                        thumbs_created += 1
                    else:
                        thumbs_cached += 1
                else:
                    thumb_rel = rel_path if f.suffix.lower() not in VIDEO_EXTS else ""

                sub_label = f.stem.replace("_", " ").replace("-", " ").strip()
                items.append({
                    "name": sub_label,
                    "fileName": f.name,
                    "src": rel_path,
                    "thumb": thumb_rel,
                    "ext": f.suffix.lower().lstrip("."),
                    "size": f.stat().st_size,
                    "isVideo": f.suffix.lower() in VIDEO_EXTS
                })

            folders_data.append({
                "id": cat_id,
                "relPath": rel_folder,
                "name": cat_name,
                "cover": items[0]["thumb"] or items[0]["src"],
                "count": len(items),
                "items": items
            })
            print(f"[ART] Zindeksowano: '{cat_name}' ({len(items)} plików)")

    orphans_removed = 0
    if args.clean_orphans and thumbs_root.is_dir():
        for existing_thumb in thumbs_root.rglob("*.webp"):
            if existing_thumb.resolve() not in active_thumb_paths:
                orphans_removed += 1
                if not args.dry_run:
                    existing_thumb.unlink(missing_ok=True)

    output = {
        "totalFolders": len(folders_data),
        "folders": folders_data
    }

    serialized = json.dumps(output, ensure_ascii=False, indent=2)
    json.loads(serialized)

    if args.dry_run:
        print(
            f"\n[DRY-RUN] Kategorii: {len(folders_data)} | Nowych miniatur: {thumbs_created} | "
            f"W pamięci podręcznej: {thumbs_cached} | Osieroconych do usunięcia: {orphans_removed}"
        )
        return

    out_path = root_dir / "art_catalog.json"
    tmp_path = root_dir / f"art_catalog.json.tmp.{os.getpid()}"
    tmp_path.write_text(serialized, encoding="utf-8")
    os.replace(tmp_path, out_path)
    print(
        f"\n[SUKCES] Zapisano {out_path} (kategorii: {len(folders_data)}, "
        f"nowych miniatur: {thumbs_created}, z cache: {thumbs_cached}, usuniętych osieroconych: {orphans_removed})."
    )


if __name__ == "__main__":
    main()
