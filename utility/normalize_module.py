#!/usr/bin/env python3
"""
Skrypt A: Uniwersalna normalizacja modułów Foundry VTT (.zip lub folderów) oraz surowych folderów z mapami.
- Obsługuje pojedynczy folder, pojedynczy plik .zip lub tryb wsadowy (--batch) skanujący podfoldery.
- Obsługuje stary i nowy format Foundry (module.json, packs/*.db, scenes.json) oraz surowe obrazy.
- Nie używa /tmp (pracuje bezpośrednio w katalogu docelowym), automatycznie odwija zagnieżdżone foldery z ZIP.
- Generuje miniatury .webp wielowątkowo na wszystkich rdzeniach CPU.
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
import zipfile
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
JUNK_NAMES = {".ds_store", "thumbs.db", "desktop.ini"}


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
    chars = string.ascii_letters + string.digits
    digest = hashlib.sha256(seed_str.encode("utf-8")).digest()
    return "".join(chars[b % len(chars)] for b in digest[:length])


def build_thumb_filename(rel_file_posix: str, stem: str) -> str:
    rel_hash = hashlib.md5(rel_file_posix.encode("utf-8")).hexdigest()[:8]
    return f"{stem}_{rel_hash}.webp"


def sanitize_module_id(raw_name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9-_]+", "-", raw_name.strip()).strip("-")
    return cleaned or "custom-map-pack"


def get_image_dimensions(file_path: Path):
    """Odczytuje wymiary (width, height) z nagłówków PNG, JPEG i WEBP."""
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
        clean = raw_path.strip().replace("\\", "/").lstrip("/")
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

        candidate = self.module_dir.joinpath(*parts)
        if candidate.is_file():
            return candidate

        rel_key = "/".join(parts).lower()
        if rel_key in self.by_rel_lower:
            return self.by_rel_lower[rel_key]

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
    db_files = sorted(set(list(src_dir.glob("packs/*.db")) + list(src_dir.glob("*.db")) + list(src_dir.rglob("packs/*.db"))))
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


def peek_zip_manifest(zip_path: Path) -> dict:
    """Odczytuje module.json z wnętrza pliku ZIP bez rozpakowywania całego archiwum."""
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            candidates = [
                m for m in zf.namelist()
                if m.replace("\\", "/").split("/")[-1].lower() == "module.json"
                and "__MACOSX" not in m
            ]
            candidates.sort(key=lambda x: len(x.replace("\\", "/").split("/")))
            if candidates:
                raw_bytes = zf.read(candidates[0])
                return json.loads(raw_bytes.decode("utf-8", errors="ignore"))
    except Exception:
        pass
    return {}


def extract_zip_cleanly(zip_path: Path, target_dir: Path):
    """Rozpakowuje archiwum ZIP bezpośrednio do target_dir i odwija pojedynczy zagnieżdżony folder główny."""
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.infolist():
            clean_name = member.filename.replace("\\", "/").lstrip("/")
            if not clean_name or "__MACOSX" in clean_name:
                continue
            parts = Path(clean_name).parts
            if not parts or any(p in ("..", ".") for p in parts):
                continue
            if parts[-1].lower() in JUNK_NAMES:
                continue

            dest_path = target_dir.joinpath(*parts)
            if member.is_dir() or member.filename.endswith(("/", "\\")):
                dest_path.mkdir(parents=True, exist_ok=True)
            else:
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as src_f, dest_path.open("wb") as dst_f:
                    shutil.copyfileobj(src_f, dst_f)

    # Jeśli module.json znajduje się w podfolderze (np. zip/nazwa-modulu/module.json), przenieś jego zawartość wyżej
    mod_jsons = sorted(
        list(target_dir.rglob("module.json")),
        key=lambda p: len(p.relative_to(target_dir).parts)
    )
    if mod_jsons and mod_jsons[0].parent != target_dir:
        inner_root = mod_jsons[0].parent
        unwrap_tmp = target_dir.parent / f".unwrap_{random_foundry_id(6)}"
        inner_root.rename(unwrap_tmp)
        shutil.rmtree(target_dir)
        unwrap_tmp.rename(target_dir)


def find_effective_source_dir(src_dir: Path) -> Path:
    """Jeśli w katalogu wejściowym module.json jest o poziom niżej, zwróć właściwy podfolder."""
    if (src_dir / "module.json").is_file() or (src_dir / "scenes.json").is_file():
        return src_dir
    mod_jsons = sorted(
        [p for p in src_dir.rglob("module.json") if len(p.relative_to(src_dir).parts) <= 3],
        key=lambda p: len(p.relative_to(src_dir).parts)
    )
    if mod_jsons:
        return mod_jsons[0].parent
    return src_dir


def process_single_item(input_path: Path, out_root: Path, args) -> bool:
    is_zip = input_path.is_file() and input_path.suffix.lower() == ".zip"

    if is_zip:
        mod_manifest = peek_zip_manifest(input_path)
        fallback_stem = input_path.stem
    else:
        effective_src = find_effective_source_dir(input_path)
        manifest_path = effective_src / "module.json"
        mod_manifest = {}
        if manifest_path.is_file():
            try:
                mod_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"[!] Nie udało się sparsować module.json w {effective_src}: {e}")
        fallback_stem = effective_src.name

    default_mod_id = sanitize_module_id(str(mod_manifest.get("id") or mod_manifest.get("name") or fallback_stem))
    default_title = str(mod_manifest.get("title") or fallback_stem.replace("-", " ").replace("_", " ").title())
    default_version = str(mod_manifest.get("version") or "1.0.0")
    default_cat = "scene" if "scene" in default_mod_id.lower() or "scene" in default_title.lower() else "map"

    non_interactive = args.non_interactive or args.batch

    if not mod_manifest.get("id") and not mod_manifest.get("name"):
        module_id = sanitize_module_id(ask_user("Podaj identyfikator modułu (moduleId)", default_mod_id, non_interactive))
    else:
        module_id = default_mod_id

    if not mod_manifest.get("title"):
        title = ask_user("Podaj tytuł paczki (title)", default_title, non_interactive)
    else:
        title = default_title

    category = ask_user("Podaj kategorię paczki ('map' lub 'scene')", default_cat, non_interactive).lower()
    if category not in ("map", "scene"):
        category = "map"

    dest_dir = (out_root / module_id).resolve()

    if not is_zip and (dest_dir == input_path or input_path in dest_dir.parents):
        print(f"[BŁĄD] Ścieżka docelowa ({dest_dir}) pokrywa się z oryginałem ({input_path})! Pomijam.")
        return False

    if dest_dir.exists():
        if args.skip_existing:
            print(f"[POMINIĘTO] Moduł '{module_id}' już istnieje w katalogu docelowym (--skip-existing).")
            return True
        if args.dry_run:
            print(f"[DRY-RUN] Moduł '{module_id}' ({dest_dir}) zostałby zastąpiony.")
            return True
        if not args.overwrite:
            ans = ask_user(f"Katalog {dest_dir.name} już istnieje. Zastąpić? (t/n)", "n", non_interactive)
            if ans.lower() not in ("t", "tak", "y", "yes"):
                print(f"[POMINIĘTO] Istniejący katalog '{module_id}' nie został zmodyfikowany.")
                return True

    if args.dry_run:
        print(f"[DRY-RUN] Przetworzono by: {input_path.name} -> {dest_dir} (tytuł: '{title}', v{default_version})")
        return True

    out_root.mkdir(parents=True, exist_ok=True)
    tmp_dir = out_root / f".tmp_{module_id}_{random_foundry_id(6)}"

    try:
        if is_zip:
            print(f"[INFO] Rozpakowywanie archiwum '{input_path.name}' -> '{module_id}'...")
            extract_zip_cleanly(input_path, tmp_dir)
        else:
            effective_src = find_effective_source_dir(input_path)
            print(f"[INFO] Kopiowanie folderu '{effective_src.name}' -> '{module_id}'...")
            shutil.copytree(effective_src, tmp_dir)

        raw_scenes, source_type = extract_raw_scenes_from_source(tmp_dir)
        all_images = sorted(
            [p for p in tmp_dir.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTS and "_thumbs" not in p.parts]
        )

        thumbs_dir = tmp_dir / "_thumbs"
        thumbs_dir.mkdir(exist_ok=True)

        file_index = ModuleFileIndex(tmp_dir)
        normalized_scenes = []
        thumb_tasks = []
        skipped_scenes = 0

        if source_type:
            for raw in raw_scenes:
                scene_name = raw.get("name") or "Scena"
                bg_raw = extract_bg_from_raw_scene(raw)

                resolved_file = file_index.resolve(bg_raw)
                if not resolved_file:
                    skipped_scenes += 1
                    print(f" [POMINIĘTO SCENĘ] Brak pliku na dysku dla '{scene_name}' ({bg_raw})")
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
            if not all_images:
                raise RuntimeError("Nie znaleziono żadnych plików graficznych (.jpg/.png/.webp).")

            for img_src in all_images:
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

        print(f"[SUKCES] {module_id} ('{title}') -> scen: {len(normalized_scenes)} | pominięto: {skipped_scenes}")

        if is_zip and args.delete_source_zip and (dest_dir / "scenes.json").is_file():
            input_path.unlink(missing_ok=True)
            print(f"[CLEANUP] Usunięto źródłowy plik ZIP: {input_path.name}")

        return True

    except Exception as e:
        print(f"[BŁĄD] Nie udało się przetworzyć '{input_path.name}': {e}")
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)
        return False


def main():
    parser = argparse.ArgumentParser(description="Skrypt A: Uniwersalna normalizacja modułów map (.zip lub folderów).")
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Ścieżka do pliku .zip, folderu modułu lub katalogu nadrzędnego (w trybie --batch).",
    )
    parser.add_argument(
        "--output-root", "-o",
        default="/srv/data/foundry-maps/modules",
        help="Katalog docelowy modułów (domyślnie: /srv/data/foundry-maps/modules).",
    )
    parser.add_argument(
        "--batch", "-b",
        action="store_true",
        help="Tryb wsadowy: znajdź i przetwórz wszystkie pliki .zip (lub podfoldery) wewnątrz --input.",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Pomiń moduły, które już istnieją w katalogu docelowym.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Nadpisz istniejące moduły w katalogu docelowym bez pytania.",
    )
    parser.add_argument(
        "--delete-source-zip",
        action="store_true",
        help="Po pomyślnej normalizacji usuń źródłowy plik .zip, aby oszczędzać miejsce na dysku.",
    )
    parser.add_argument(
        "--workers", "-w",
        type=int,
        default=min(8, os.cpu_count() or 4),
        help="Liczba wątków generowania miniatur.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Tylko pokaż co zostanie zrobione, bez zapisu na dysk.")
    parser.add_argument("--non-interactive", action="store_true", help="Nie pytaj w konsoli, użyj wartości domyślnych.")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    out_root = Path(args.output_root).resolve()

    if not input_path.exists():
        print(f"[BŁĄD] Ścieżka wejściowa nie istnieje: {input_path}")
        sys.exit(1)

    if args.batch:
        if not input_path.is_dir():
            print(f"[BŁĄD] W trybie --batch ścieżka --input musi być katalogiem: {input_path}")
            sys.exit(1)

        zip_files = sorted(input_path.rglob("*.zip"))
        if zip_files:
            targets = zip_files
            print(f"[BATCH] Znaleziono {len(targets)} archiwów .zip w: {input_path}")
        else:
            targets = sorted([d for d in input_path.iterdir() if d.is_dir() and not d.name.startswith(".")])
            print(f"[BATCH] Znaleziono {len(targets)} podfolderów w: {input_path}")

        ok_cnt = 0
        fail_cnt = 0
        for idx, target in enumerate(targets, 1):
            print(f"\n--- [{idx} / {len(targets)}] {target.name} ---")
            if process_single_item(target, out_root, args):
                ok_cnt += 1
            else:
                fail_cnt += 1

        print(f"\n=== Podsumowanie wsadowe (Batch) ===")
        print(f" * Przetworzono pomyślnie: {ok_cnt}")
        print(f" * Błędy / pominięte:      {fail_cnt}")
        if fail_cnt > 0:
            sys.exit(1)
    else:
        if not process_single_item(input_path, out_root, args):
            sys.exit(1)


if __name__ == "__main__":
    main()
