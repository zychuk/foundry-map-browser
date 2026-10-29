#!/usr/bin/env python3
"""
Skrypt A: Normalizacja surowego folderu z mapami lub modułu Foundry VTT.
- Zawsze pracuje na kopii (nigdy nie modyfikuje katalogu wejściowego).
- Obsługuje zarówno moduły Foundry (module.json, packs/*.db, scenes.json),
  jak i surowe foldery ze zwykłymi plikami graficznymi (.jpg, .png, .webp).
- Generuje miniatury .webp wielowątkowo na wszystkich rdzeniach CPU.
- Obsługuje tryb --dry-run oraz tryb interaktywny.
"""

import argparse
import hashlib
import json
import os
import random
import re
import shutil
import string
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import unquote

try:
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = None
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False

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


def deterministic_foundry_id(seed_str: str, length: int = 16) -> str:
    """Generuje deterministyczne 16-znakowe ID na podstawie ścieżki, aby ponowna normalizacja zachowywała te same ID."""
    chars = string.ascii_letters + string.digits
    digest = hashlib.sha256(seed_str.encode("utf-8")).digest()
    return "".join(chars[b % len(chars)] for b in digest[:length])


def build_thumb_filename(rel_file_posix: str, stem: str) -> str:
    rel_hash = hashlib.md5(rel_file_posix.encode("utf-8")).hexdigest()[:8]
    return f"{stem}_{rel_hash}.webp"


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


class ModuleFileIndex:
    """Szybki indeks plików wewnątrz katalogu modułu (case-insensitive)."""

    def __init__(self, module_dir: Path):
        self.module_dir = module_dir
        self.by_rel_lower = {}
        self.by_filename_lower = {}

        for p in sorted(module_dir.rglob("*")):
            if not p.is_file() or "_thumbs" in p.parts:
                continue
            rel_posix = p.relative_to(module_dir).as_posix()
            self.by_rel_lower[rel_posix.lower()] = p
            fname_lower = p.name.lower()
            if fname_lower not in self.by_filename_lower:
                self.by_filename_lower[fname_lower] = p

    def resolve(self, raw_path: str) -> Path | None:
        if not raw_path or not isinstance(raw_path, str):
            return None
        clean = raw_path.strip().lstrip("/")
        if clean.startswith(("http://", "https://", "data:", "icons/", "ui/")):
            return None
        try:
            clean = unquote(clean)
        except Exception:
            pass

        parts = list(Path(clean).parts)
        if len(parts) >= 2 and parts[0].lower() in ("modules", "worlds"):
            parts = parts[2:]

        if not parts:
            return None

        # 1. Dokładna ścieżka
        candidate = self.module_dir.joinpath(*parts)
        if candidate.is_file():
            return candidate

        # 2. Ścieżka względna bez względu na wielkość liter
        rel_key = "/".join(parts).lower()
        if rel_key in self.by_rel_lower:
            return self.by_rel_lower[rel_key]

        # 3. Dopasowanie po samej nazwie pliku
        return self.by_filename_lower.get(parts[-1].lower())


def extract_bg_from_raw_scene(raw: dict) -> str | None:
    if not isinstance(raw, dict):
        return None
    bg_obj = raw.get("background")
    if isinstance(bg_obj, dict) and bg_obj.get("src"):
        return bg_obj.get("src")
    if isinstance(raw.get("img"), str) and raw.get("img"):
        return raw.get("img")
    levels = raw.get("levels")
    if isinstance(levels, list) and levels:
        first_lvl = levels[0]
        if isinstance(first_lvl, dict):
            lvl_bg = (first_lvl.get("background") or {}).get("src") if isinstance(first_lvl.get("background"), dict) else None
            if lvl_bg:
                return lvl_bg
    if isinstance(raw.get("bg"), str) and raw.get("bg"):
        return raw.get("bg")
    return None


def normalize_subasset_paths(raw: dict, file_index: ModuleFileIndex, module_id: str):
    """Normalizuje wielkość liter i prefiks modules/<id>/ dla kafelków, tokenów, dźwięków i poziomów."""
    def to_canonical(path_str: str) -> str:
        resolved = file_index.resolve(path_str)
        if resolved:
            return f"modules/{module_id}/{resolved.relative_to(file_index.module_dir).as_posix()}"
        return path_str

    if isinstance(raw.get("foreground"), str) and raw["foreground"]:
        raw["foreground"] = to_canonical(raw["foreground"])

    for key in ("tiles", "tokens"):
        items = raw.get(key)
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                tex = item.get("texture")
                if isinstance(tex, dict) and isinstance(tex.get("src"), str) and tex["src"]:
                    tex["src"] = to_canonical(tex["src"])
                elif isinstance(item.get("img"), str) and item["img"]:
                    item["texture"] = {"src": to_canonical(item["img"])}
                    del item["img"]

    sounds = raw.get("sounds")
    if isinstance(sounds, list):
        for s in sounds:
            if isinstance(s, dict) and isinstance(s.get("path"), str) and s["path"]:
                s["path"] = to_canonical(s["path"])

    levels = raw.get("levels")
    if isinstance(levels, list):
        for lvl in levels:
            if not isinstance(lvl, dict):
                continue
            lvl_bg = lvl.get("background")
            if isinstance(lvl_bg, dict) and isinstance(lvl_bg.get("src"), str) and lvl_bg["src"]:
                lvl_bg["src"] = to_canonical(lvl_bg["src"])


def generate_webp_thumbnail(src_image: Path, dest_webp: Path) -> bool:
    """Generuje miniaturkę .webp używając cwebp, ffmpeg lub Pillow (jeśli dostępne)."""
    dest_webp.parent.mkdir(parents=True, exist_ok=True)
    if dest_webp.is_file() and dest_webp.stat().st_size > 0:
        return True

    if shutil.which("cwebp"):
        res = subprocess.run(
            ["cwebp", "-quiet", "-resize", "480", "0", "-q", "80", str(src_image), "-o", str(dest_webp)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if res.returncode == 0 and dest_webp.is_file() and dest_webp.stat().st_size > 0:
            return True

    if shutil.which("ffmpeg"):
        res = subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-i", str(src_image),
                "-frames:v", "1",
                "-vf", "scale=480:-1",
                "-q:v", "75",
                str(dest_webp),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if res.returncode == 0 and dest_webp.is_file() and dest_webp.stat().st_size > 0:
            return True

    if HAS_PILLOW:
        try:
            with Image.open(src_image) as im:
                im = ImageOps.exif_transpose(im)
                if im.mode not in ("RGB", "RGBA"):
                    im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
                im.thumbnail((480, 480), Image.Resampling.LANCZOS)
                im.save(dest_webp, "WEBP", quality=80)
            return True
        except Exception:
            pass

    return False


def is_scene_doc(doc: dict) -> bool:
    if not isinstance(doc, dict):
        return False
    has_scene_structure = any(k in doc for k in ("walls", "lights", "tiles", "drawings", "levels"))
    has_image = bool(extract_bg_from_raw_scene(doc) or doc.get("foreground"))
    return (has_scene_structure or ("width" in doc and "height" in doc and "grid" in doc)) and has_image


def extract_raw_scenes_from_source(src_dir: Path):
    """Wykrywa sceny z scenes.json lub baz NeDB (packs/*.db)."""
    scenes_json = src_dir / "scenes.json"
    if scenes_json.is_file():
        try:
            data = json.loads(scenes_json.read_text(encoding="utf-8"))
            if isinstance(data, list) and data:
                return data, "scenes.json"
        except Exception as e:
            print(f"[!] Ostrzeżenie: nie udało się odczytać {scenes_json}: {e}")

    scenes = []
    matched_dbs = []
    db_files = sorted(set(list(src_dir.glob("packs/*.db")) + list(src_dir.glob("*.db"))))
    for db_file in db_files:
        file_scenes = []
        try:
            for line in db_file.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = line.strip()
                if not line:
                    continue
                doc = json.loads(line)
                if is_scene_doc(doc):
                    file_scenes.append(doc)
        except Exception as e:
            print(f"[!] Ostrzeżenie podczas czytania {db_file.name}: {e}")
        if file_scenes:
            scenes.extend(file_scenes)
            matched_dbs.append(db_file.name)

    if scenes:
        return scenes, f"bazy: {', '.join(matched_dbs)}"

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
    parser.add_argument(
        "--workers",
        "-w",
        type=int,
        default=min(8, os.cpu_count() or 4),
        help="Liczba wątków generowania miniatur (domyślnie: min(8, liczba rdzeni)).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Tylko pokaż co zostanie zrobione, bez zapisu na dysk.")
    parser.add_argument("--non-interactive", action="store_true", help="Nie pytaj w konsoli, użyj wartości domyślnych.")
    args = parser.parse_args()

    src_dir = Path(args.input).resolve()
    out_root = Path(args.output_root).resolve()

    if not src_dir.is_dir():
        print(f"[BŁĄD] Folder wejściowy nie istnieje: {src_dir}")
        sys.exit(1)

    mod_manifest = {}
    manifest_path = src_dir / "module.json"
    if manifest_path.is_file():
        try:
            mod_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            print("[INFO] Wykryto plik module.json w katalogu wejściowym.")
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

    all_images = sorted(
        [p for p in src_dir.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTS and "_thumbs" not in p.parts]
    )

    print("\n=== Podsumowanie analizy wejścia ===")
    print(f" * Źródło:          {src_dir}")
    print(f" * Cel (kopia):     {dest_dir}")
    print(f" * ID modułu:       {module_id}")
    print(f" * Tytuł:           {title} (v{default_version}, kategoria: {category})")
    print(f" * Tryb wejścia:    {'Moduł Foundry (' + source_type + ')' if source_type else 'Surowy folder z obrazami'}")
    print(f" * Pliki graficzne: {len(all_images)} szt.")

    if args.dry_run:
        if source_type:
            src_index = ModuleFileIndex(src_dir)
            valid_cnt = 0
            ghost_cnt = 0
            for r in raw_scenes:
                bg = extract_bg_from_raw_scene(r)
                if src_index.resolve(bg):
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

    tmp_dir = out_root / f".tmp_{module_id}_{random_foundry_id(6)}"
    try:
        out_root.mkdir(parents=True, exist_ok=True)
        print("[INFO] Kopiowanie plików do tymczasowego katalogu roboczego...")
        shutil.copytree(src_dir, tmp_dir)

        thumbs_dir = tmp_dir / "_thumbs"
        thumbs_dir.mkdir(exist_ok=True)

        file_index = ModuleFileIndex(tmp_dir)
        normalized_scenes = []
        thumb_tasks = []
        skipped_scenes = 0

        if source_type:
            # Wariant 1: Normalizacja istniejącego modułu Foundry
            for raw in raw_scenes:
                scene_name = raw.get("name") or "Scena"
                bg_raw = extract_bg_from_raw_scene(raw)

                resolved_file = file_index.resolve(bg_raw)
                if not resolved_file:
                    skipped_scenes += 1
                    print(f" [POMINIĘTO] Brak pliku graficznego na dysku dla sceny '{scene_name}' ({bg_raw})")
                    continue

                rel_file = resolved_file.relative_to(tmp_dir).as_posix()
                scene_id = raw.get("_id") or deterministic_foundry_id(f"{module_id}:{rel_file}")
                canonical_bg = f"modules/{module_id}/{rel_file}"

                thumb_name = build_thumb_filename(rel_file, resolved_file.stem)
                thumb_file = thumbs_dir / thumb_name
                canonical_thumb = f"modules/{module_id}/_thumbs/{thumb_name}"

                w = raw.get("width")
                h = raw.get("height")
                if not w or not h:
                    w, h = get_image_dimensions(resolved_file)

                normalize_subasset_paths(raw, file_index, module_id)

                raw["_id"] = scene_id
                raw["width"] = int(w)
                raw["height"] = int(h)
                raw["background"] = {"src": canonical_bg}
                raw["thumb"] = canonical_bg
                if "img" in raw:
                    del raw["img"]

                normalized_scenes.append(raw)
                thumb_tasks.append((raw, resolved_file, thumb_file, canonical_thumb, canonical_bg))
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

                thumb_name = build_thumb_filename(rel_file, img_src.stem)
                thumb_file = thumbs_dir / thumb_name
                canonical_thumb = f"modules/{module_id}/_thumbs/{thumb_name}"

                clean_scene_name = img_src.stem.replace("_", " ").replace("-", " ").strip()
                scene_doc = {
                    "_id": deterministic_foundry_id(f"{module_id}:{rel_file}"),
                    "name": clean_scene_name,
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

        if not normalized_scenes:
            raise RuntimeError("Po weryfikacji nie została ani jedna poprawna scena do zapisania.")

        print(f"[INFO] Generowanie miniatur ({len(thumb_tasks)} szt., wątki: {max(1, args.workers)})...")
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = [
                (scene_doc, canonical_thumb, canonical_bg, pool.submit(generate_webp_thumbnail, src_img, t_file))
                for scene_doc, src_img, t_file, canonical_thumb, canonical_bg in thumb_tasks
            ]
            for scene_doc, canonical_thumb, canonical_bg, fut in futures:
                scene_doc["thumb"] = canonical_thumb if fut.result() else canonical_bg

        scenes_json_text = json.dumps(normalized_scenes, ensure_ascii=False, indent=2)
        json.loads(scenes_json_text)
        (tmp_dir / "scenes.json").write_text(scenes_json_text, encoding="utf-8")

        norm_manifest = {
            "id": module_id,
            "title": title,
            "version": default_version,
            "category": category
        }
        (tmp_dir / "module.json").write_text(json.dumps(norm_manifest, ensure_ascii=False, indent=2), encoding="utf-8")

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
