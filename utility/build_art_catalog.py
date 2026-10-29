#!/usr/bin/env python3
"""
Skanuje /srv/data/foundry-maps/art/ (rekursywnie),
generuje miniatury .webp z BIAŁYM tłem pod przezroczystymi PNG/WebP,
oraz zapisuje art_catalog.json.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

MEDIA_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm"}
VIDEO_EXTS = {".mp4", ".webm"}


def format_category_name(rel_folder_path: str) -> str:
    parts = Path(rel_folder_path).parts
    clean_parts = [p.replace("_", " ").replace("-", " ").strip() for p in parts]
    return " / ".join(clean_parts) if clean_parts else "General"


def make_thumb(src: Path, dest: Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_size > 0 and dest.stat().st_mtime >= src.stat().st_mtime:
        return True

    ext = src.suffix.lower()

    # 1. Metoda główna: Pillow (kompleksowa obsługa trybów RGBA, P, L)
    if ext not in VIDEO_EXTS:
        try:
            from PIL import Image
            with Image.open(src) as im:
                # Konwersja do RGBA z obsługą palety (P) i przezroczystości
                if im.mode != "RGBA":
                    im = im.convert("RGBA")

                # Białe tło pod spód
                bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
                combined = Image.alpha_composite(bg, im).convert("RGB")
                combined.thumbnail((480, 480), Image.Resampling.LANCZOS)
                combined.save(dest, "WEBP", quality=80)
                return True
        except Exception as e:
            # Wypisz błąd, aby nie ukrywać przyczyny
            print(f"[!] Błąd Pillow dla {src.name}: {e}", file=sys.stderr)

    # 2. Fallback: ffmpeg
    if shutil.which("ffmpeg"):
        cmd = ["ffmpeg", "-y", "-v", "error"]
        if ext in VIDEO_EXTS:
            cmd += ["-ss", "00:00:00.500"]
        cmd += [
            "-i", str(src),
            "-vframes", "1",
            "-filter_complex", "color=white:s=480x480[bg];[0:v]scale=480:-1[fg];[bg][fg]overlay=shortest=1",
            "-q:v", "75",
            str(dest)
        ]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode == 0 and dest.is_file() and dest.stat().st_size > 0:
            return True

    # 3. Fallback: cwebp
    if ext not in VIDEO_EXTS and ext != ".gif" and shutil.which("cwebp"):
        res = subprocess.run(
            ["cwebp", "-quiet", "-resize", "480", "0", "-q", "80", str(src), "-o", str(dest)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if res.returncode == 0 and dest.is_file() and dest.stat().st_size > 0:
            return True

    return False


def main():
    parser = argparse.ArgumentParser(description="Buduje art_catalog.json z podfolderów w art/.")
    parser.add_argument("--root", "-r", default="/srv/data/foundry-maps", help="Główny katalog serwera.")
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
    total_thumbs_created = 0

    for folder in sorted_dirs:
        rel_folder = folder.relative_to(art_dir).as_posix()
        cat_id = rel_folder.lower().replace("/", "__").replace(" ", "-").replace("_", "-")
        cat_name = format_category_name(rel_folder)

        files = sorted([f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in MEDIA_EXTS])
        if not files:
            continue

        items = []
        for f in files:
            rel_path = f.relative_to(root_dir).as_posix()
            short_hash = hashlib.md5(rel_path.encode("utf-8")).hexdigest()[:10]
            thumb_file = thumbs_root / rel_folder / f"{f.stem}_{short_hash}.webp"

            if make_thumb(f, thumb_file):
                thumb_rel = thumb_file.relative_to(root_dir).as_posix()
                total_thumbs_created += 1
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

    output = {
        "totalFolders": len(folders_data),
        "folders": folders_data
    }

    out_path = root_dir / "art_catalog.json"
    tmp_path = root_dir / f"art_catalog.json.tmp.{os.getpid()}"
    serialized = json.dumps(output, ensure_ascii=False, indent=2)
    json.loads(serialized)

    tmp_path.write_text(serialized, encoding="utf-8")
    os.replace(tmp_path, out_path)
    print(f"\n[SUKCES] Zapisano {out_path} (kategorii: {len(folders_data)}, miniatur zrobionych: {total_thumbs_created}).")


if __name__ == "__main__":
    main()
