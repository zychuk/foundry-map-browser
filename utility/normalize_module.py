#!/usr/bin/env python3
"""
Skrypt A: Normalizacja surowego folderu z mapami lub modułu Foundry VTT.
- Zawsze pracuje na kopii (nigdy nie modyfikuje katalogu wejściowego).
- Obsługuje zarówno moduły Foundry (module.json, packs/*.db, scenes.json),
  jak i surowe foldery ze zwykłymi plikami graficznymi (.jpg, .png, .webp).
- Obsługuje tryb --dry-run oraz tryb interaktywny.
"""

import argparse
import json
import os
import random
import re
import shutil
import string
import struct
import subprocess
import sys
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def ask_user(prompt_text: str, default_val: str = "", non_interactive: bool = False) -> str:
    if non_interactive or not sys.stdin.isatty():
        return default_val
    suffix = f" [{default_val}]: " if default_val else ": "
    try:
        ans = input(f"[?] {prompt_text}{suffix}").strip()
        return ans if ans else default_val
    except (EOFError, KeyboardInterrupt):
        print("\n[!] Przerwano przez użytkownika.")
        sys.exit(1)


def random_foundry_id(length: int = 16) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def get_image_dimensions(file_path: Path):
    """Odczytuje wymiary (width, height) z nagłówków PNG, JPEG i WEBP bez zewnętrznych bibliotek."""
    try:
        with file_path.open("rb") as f:
            head = f.read(32)
            if len(head) < 16:
                return 4000, 3000

            # PNG
            if head.startswith(b"\x89PNG\r\n\x1a\n") and head[12:16] == b"IHDR":
                w, h = struct.unpack(">II", head[16:24])
                return int(w), int(h)

            # WEBP
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                chunk = head[12:16]
                if chunk == b"VP8 " and len(head) >= 30:
                    w, h = struct.unpack("<HH", head[26:30])
                    return int(w & 0x3FFF), int(h & 0x3FFF)
                if chunk == b"VP8L" and len(head) >= 25:
                    b = struct.unpack("<I", head[21:25])[0]
                    w = (b & 0x3FFF) + 1
                    h = ((b >> 14) & 0x3FFF) + 1
                    return int(w), int(h)
                if chunk == b"VP8X" and len(head) >= 30:
                    w = int.from_bytes(head[24:27], "little") + 1
                    h = int.from_bytes(head[27:30], "little") + 1
                    return int(w), int(h)

            # JPEG
            if head[:2] == b"\xff\xd8":
                f.seek(2)
                while True:
                    byte = f.read(1)
                    if not byte:
                        break
                    if byte != b"\xff":
                        continue
                    while byte == b"\xff":
                        byte = f.read(1)
                    if not byte:
                        break
                    marker = byte[0]
                    if marker in (0xD8, 0xD9) or (0xD0 <= marker <= 0xD7):
                        continue
                    size_bytes = f.read(2)
                    if len(size_bytes) < 2:
                        break
                    seg_size = struct.unpack(">H", size_bytes)[0]
                    if seg_size < 2:
                        break
                    if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                        seg_data = f.read(5)
                        if len(seg_data) == 5:
                            h, w = struct.unpack(">HH", seg_data[1:5])
                            return int(w), int(h)
                        break
                    f.seek(seg_size - 2, os.SEEK_CUR)
    except Exception:
        pass
    return 4000, 3000


def resolve_file_in_module(module_dir: Path, raw_path: str):
    """Szuka pliku wewnątrz kopii modułu (niezależnie od wielkości liter i prefiksu modules/<id>/)."""
    if not raw_path or not isinstance(raw_path, str):
        return None
    clean = raw_path.strip().lstrip("/")
    try:
        from urllib.parse import unquote
        clean = unquote(clean)
    except Exception:
        pass

    parts = list(Path(clean).parts)
    if len(parts) >= 2 and parts[0].lower() == "modules":
        parts = parts[2:]

    if not parts:
        return None

    # 1. Dokładna ścieżka
    candidate = module_dir.joinpath(*parts)
    if candidate.is_file():
        return candidate

    # 2. Dopasowanie bez względu na wielkość liter (case-insensitive)
    curr = module_dir
    for part in parts:
        if not curr.is_dir():
            curr = None
            break
        match = next((p for p in curr.iterdir() if p.name.lower() == part.lower()), None)
        if not match:
            curr = None
            break
        curr = match
    if curr and curr.is_file():
        return curr

    # 3. Dopasowanie po samej nazwie pliku w całym folderze modułu
    target_filename = parts[-1].lower()
    for p in module_dir.rglob("*"):
        if p.is_file() and p.parent.name != "_thumbs" and p.name.lower() == target_filename:
            return p

    return None


def generate_webp_thumbnail(src_image: Path, dest_webp: Path) -> bool:
    """Generuje miniaturkę .webp używając cwebp, ffmpeg lub Pillow (jeśli dostępne)."""
    dest_webp.parent.mkdir(parents=True, exist_ok=True)
    if dest_webp.is_file():
        return True

    if shutil.which("cwebp"):
        res = subprocess.run(
            ["cwebp", "-quiet", "-resize", "480", "0", "-q", "80", str(src_image), "-o", str(dest_webp)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if res.returncode == 0 and dest_webp.is_file():
            return True

    if shutil.which("ffmpeg"):
        res = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(src_image), "-vf", "scale=480:-1", "-q:v", "75", str(dest_webp)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if res.returncode == 0 and dest_webp.is_file():
            return True

    try:
        from PIL import Image
        with Image.open(src_image) as im:
            im.thumbnail((480, 480))
            im.save(dest_webp, "WEBP", quality=80)
        return True
    except Exception:
        pass

    return False


def extract_raw_scenes_from_source(src_dir: Path):
    """Wykrywa sceny z scenes.json lub baz NeDB (packs/*.db)."""
    scenes = []
    scenes_json = src_dir / "scenes.json"
    if scenes_json.is_file():
        try:
            data = json.loads(scenes_json.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data, "scenes.json"
        except Exception as e:
            print(f"[!] Ostrzeżenie: nie udało się odczytać {scenes_json}: {e}")

    db_files = list(src_dir.glob("packs/*.db")) + list(src_dir.glob("*.db"))
    for db_file in db_files:
        try:
            for line in db_file.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = line.strip()
                if not line:
                    continue
                doc = json.loads(line)
                if isinstance(doc, dict) and ("walls" in doc or "img" in doc or "background" in doc or "grid" in doc):
                    scenes.append(doc)
        except Exception as e:
            print(f"[!] Ostrzeżenie podczas czytania {db_file.name}: {e}")
        if scenes:
            return scenes, f"baza {db_file.name}"

    return [], None


def sanitize_module_id(raw_name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9-_]+", "-", raw_name.strip()).strip("-")
    return cleaned or "custom-map-pack"


def main():
    parser = argparse.ArgumentParser(description="Skrypt A: Normalizacja modułu map (praca na kopii).")
    parser.add_argument("--input", "-i", required=True, help="Ścieżka do surowego folderu wejściowego.")
    parser.add_argument(
        "--output-root",
        "-o",
        default="/srv/data/foundry-maps/modules",
        help="Katalog docelowy modułów (domyślnie: /srv/data/foundry-maps/modules).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Tylko pokaż co zostanie zrobione, bez zapisu na dysk.")
    parser.add_argument("--non-interactive", action="store_true", help="Nie pytaj w konsoli, użyj wartości domyślnych.")
    args = parser.parse_args()

    src_dir = Path(args.input).resolve()
    out_root = Path(args.output_root).resolve()

    if not src_dir.is_dir():
        print(f"[BŁĄD] Folder wejściowy nie istnieje: {src_dir}")
        sys.exit(1)

    # Odczyt module.json jeśli istnieje
    mod_manifest = {}
    manifest_path = src_dir / "module.json"
    if manifest_path.is_file():
        try:
            mod_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            print(f"[INFO] Wykryto plik module.json w katalogu wejściowym.")
        except Exception as e:
            print(f"[!] Nie udało się sparsować module.json: {e}")

    default_mod_id = mod_manifest.get("id") or mod_manifest.get("name") or sanitize_module_id(src_dir.name)
    default_title = mod_manifest.get("title") or src_dir.name.replace("-", " ").replace("_", " ").title()
    default_version = str(mod_manifest.get("version") or "1.0.0")
    default_cat = "scene" if "scene" in default_mod_id.lower() or "scene" in default_title.lower() else "map"

    if not mod_manifest.get("id") and not mod_manifest.get("name"):
        module_id = ask_user("Podaj identyfikator modułu (moduleId)", default_mod_id, args.non_interactive)
    else:
        module_id = default_mod_id

    if not mod_manifest.get("title"):
        title = ask_user("Podaj tytuł paczki (title)", default_title, args.non_interactive)
    else:
        title = default_title

    category = ask_user("Podaj kategorię paczki ('map' lub 'scene')", default_cat, args.non_interactive).lower()
    if category not in ("map", "scene"):
        category = "map"

    dest_dir = (out_root / module_id).resolve()

    # Zabezpieczenie oryginału
    if dest_dir == src_dir or src_dir in dest_dir.parents:
        print(f"[BŁĄD] Ścieżka docelowa ({dest_dir}) pokrywa się z oryginałem ({src_dir})! Przerywam.")
        sys.exit(1)

    if dest_dir.exists():
        print(f"[!] Katalog docelowy już istnieje: {dest_dir}")
        if args.dry_run:
            print("[DRY-RUN] Katalog docelowy zostałby nadpisany nową kopią.")
        else:
            ans = ask_user("Czy chcesz zastąpić istniejącą kopię w katalogu docelowym? (t/n)", "n", args.non_interactive)
            if ans.lower() not in ("t", "tak", "y", "yes"):
                print("[INFO] Pominięto – istniejący katalog nie został zmodyfikowany.")
                sys.exit(0)

    raw_scenes, source_type = extract_raw_scenes_from_source(src_dir)

    # Szukanie wszystkich plików graficznych w folderze źródłowym (poza _thumbs)
    all_images = sorted(
        [p for p in src_dir.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTS and "_thumbs" not in p.parts]
    )

    print(f"\n=== Podsumowanie analizy wejścia ===")
    print(f" * Źródło:          {src_dir}")
    print(f" * Cel (kopia):     {dest_dir}")
    print(f" * ID modułu:       {module_id}")
    print(f" * Tytuł:           {title} (v{default_version}, kategoria: {category})")
    print(f" * Tryb wejścia:    {'Moduł Foundry (' + source_type + ')' if source_type else 'Surowy folder z obrazami'}")
    print(f" * Pliki graficzne: {len(all_images)} szt.")

    if args.dry_run:
        if source_type:
            valid_cnt = 0
            ghost_cnt = 0
            for r in raw_scenes:
                bg = (r.get("background") or {}).get("src") if isinstance(r.get("background"), dict) else None
                bg = bg or r.get("img")
                if resolve_file_in_module(src_dir, bg):
                    valid_cnt += 1
                else:
                    ghost_cnt += 1
                    print(f"   [DRY-RUN] Pominięto martwą scenę (brak pliku tła): {r.get('name')} -> {bg}")
            print(f"[DRY-RUN] Zostanie zapisanych {valid_cnt} poprawnych scen (odrzucono {ghost_cnt} martwych wpisów).")
        else:
            for img in all_images:
                w, h = get_image_dimensions(img)
                print(f"   [DRY-RUN] Utworzono by scenę z obrazu: {img.relative_to(src_dir)} ({w}x{h})")
        print("[DRY-RUN] Zakończono symulację. Żadne pliki nie zostały zmodyfikowane.")
        return

    # Bezpieczna praca na tymczasowej kopii przed przeniesieniem na miejsce docelowe
    tmp_dir = out_root / f".tmp_{module_id}_{random_foundry_id(6)}"
    try:
        out_root.mkdir(parents=True, exist_ok=True)
        print(f"[INFO] Kopiowanie plików do tymczasowego katalogu roboczego...")
        shutil.copytree(src_dir, tmp_dir)

        thumbs_dir = tmp_dir / "_thumbs"
        thumbs_dir.mkdir(exist_ok=True)

        normalized_scenes = []
        skipped_scenes = 0

        if source_type:
            # Wariant 1: Normalizacja istniejącego modułu Foundry
            for raw in raw_scenes:
                scene_id = raw.get("_id") or random_foundry_id()
                scene_name = raw.get("name") or "Scena"
                bg_raw = (raw.get("background") or {}).get("src") if isinstance(raw.get("background"), dict) else None
                bg_raw = bg_raw or raw.get("img")

                resolved_file = resolve_file_in_module(tmp_dir, bg_raw)
                if not resolved_file:
                    skipped_scenes += 1
                    print(f" [POMINIĘTO] Brak pliku graficznego na dysku dla sceny '{scene_name}' ({bg_raw})")
                    continue

                rel_file = resolved_file.relative_to(tmp_dir).as_posix()
                canonical_bg = f"modules/{module_id}/{rel_file}"

                thumb_name = f"{resolved_file.stem}.webp"
                thumb_file = thumbs_dir / thumb_name
                if generate_webp_thumbnail(resolved_file, thumb_file):
                    canonical_thumb = f"modules/{module_id}/_thumbs/{thumb_name}"
                else:
                    canonical_thumb = canonical_bg

                w = raw.get("width")
                h = raw.get("height")
                if not w or not h:
                    w, h = get_image_dimensions(resolved_file)

                raw["_id"] = scene_id
                raw["width"] = int(w)
                raw["height"] = int(h)
                raw["background"] = {"src": canonical_bg}
                raw["thumb"] = canonical_thumb
                if "img" in raw:
                    del raw["img"]

                normalized_scenes.append(raw)
        else:
            # Wariant 2: Generowanie scen z surowego folderu z grafikami
            if not all_images:
                raise RuntimeError("W podanym folderze nie znaleziono żadnych plików graficznych (.jpg/.png/.webp).")

            for img_src in sorted(
                [p for p in tmp_dir.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTS and "_thumbs" not in p.parts]
            ):
                rel_file = img_src.relative_to(tmp_dir).as_posix()
                canonical_bg = f"modules/{module_id}/{rel_file}"
                w, h = get_image_dimensions(img_src)

                thumb_name = f"{img_src.stem}.webp"
                thumb_file = thumbs_dir / thumb_name
                if generate_webp_thumbnail(img_src, thumb_file):
                    canonical_thumb = f"modules/{module_id}/_thumbs/{thumb_name}"
                else:
                    canonical_thumb = canonical_bg

                clean_scene_name = img_src.stem.replace("_", " ").replace("-", " ").strip()
                normalized_scenes.append({
                    "_id": random_foundry_id(),
                    "name": clean_scene_name,
                    "width": int(w),
                    "height": int(h),
                    "grid": {"size": 100, "type": 1, "distance": 5, "units": "ft"},
                    "background": {"src": canonical_bg},
                    "thumb": canonical_thumb,
                    "walls": [],
                    "lights": [],
                    "tiles": []
                })

        if not normalized_scenes:
            raise RuntimeError("Po weryfikacji nie została ani jedna poprawna scena do zapisania.")

        # Zapis zwalidowanego pliku scenes.json
        scenes_json_text = json.dumps(normalized_scenes, ensure_ascii=False, indent=2)
        json.loads(scenes_json_text)  # Walidacja składni
        (tmp_dir / "scenes.json").write_text(scenes_json_text, encoding="utf-8")

        # Zapis/aktualizacja module.json w kopii, aby Skrypt B znał metadane
        norm_manifest = {
            "id": module_id,
            "title": title,
            "version": default_version,
            "category": category
        }
        (tmp_dir / "module.json").write_text(json.dumps(norm_manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        # Atomowa podmiana katalogu docelowego
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        tmp_dir.rename(dest_dir)

        print(f"[SUKCES] Znormalizowano moduł do: {dest_dir}")
        print(f"         Dodano scen: {len(normalized_scenes)} | Pominięto uszkodzonych: {skipped_scenes}")

    except Exception as e:
        print(f"[BŁĄD KRYTYCZNY] Operacja przerwana: {e}")
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
