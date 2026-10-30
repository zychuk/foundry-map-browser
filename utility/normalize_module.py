#!/usr/bin/env python3
"""
Skrypt A: Uniwersalna normalizacja i optymalizacja modułów Foundry VTT (.zip lub folderów) oraz surowych map.
- Obsługuje stary format NeDB (packs/*.db), nowy format LevelDB v11-v14 (packs/*/*.ldb, *.log),
  scenes.json oraz surowe foldery z obrazami (.jpg, .png, .webp, .avif).
- Automatycznie konwertuje pliki .avif oraz .png do .webp w jakości 90 (100% kompatybilności i oszczędność miejsca).
- Usuwa z wynikowego modułu nieużywane pliki (bazy packs/, duplikaty z siatką, stare foldery thumbs/, PDF-y).
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

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".avif"}
JUNK_NAMES = {".ds_store", "thumbs.db", "desktop.ini"}
THUMB_DIR_NAMES = {"_thumbs", "thumbs", "thumbnails", "thumb"}


def is_thumb_dir_part(parts: tuple[str, ...]) -> bool:
    for p in parts:
        pl = p.lower()
        if pl in THUMB_DIR_NAMES or pl.endswith("-thumbs") or pl.endswith("_thumbs"):
            return True
    return False


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
    """Odczytuje wymiary (width, height) z nagłówków PNG/JPEG/WEBP, Pillow lub ffprobe (dla AVIF)."""
    try:
        with file_path.open("rb") as f:
            head = f.read(32)
            if len(head) >= 16:
                if head.startswith(b"\x89PNG\r\n\x1a\n") and head[12:16] == b"IHDR":
                    w, h = struct.unpack(">II", head[16:24])
                    return int(w), int(h)

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

    if HAS_PILLOW:
        try:
            with Image.open(file_path) as im:
                return int(im.width), int(im.height)
        except Exception:
            pass

    if shutil.which("ffprobe"):
        try:
            res = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-select_streams", "v:0",
                    "-show_entries", "stream=width,height", "-of", "json", str(file_path)
                ],
                capture_output=True, text=True, timeout=10
            )
            if res.returncode == 0:
                streams = json.loads(res.stdout).get("streams", [])
                if streams:
                    return int(streams[0]["width"]), int(streams[0]["height"])
        except Exception:
            pass

    return 4000, 3000


def convert_image_to_webp(src_path: Path, quality: int = 90) -> Path:
    """
    Konwertuje plik .avif lub .png (lub .jpg) do .webp w jakości 90.
    Jeśli konwersja się powiedzie, usuwa oryginał i zwraca nową ścieżkę .webp.
    """
    try:
        if not src_path.is_file():
            return src_path
        orig_size = src_path.stat().st_size
    except OSError:
        return src_path

    dest_webp = src_path.with_suffix(".webp")
    if dest_webp == src_path:
        return src_path

    tmp_webp = src_path.with_name(f".conv_{src_path.stem}_{random_foundry_id(4)}.webp")
    ext = src_path.suffix.lower()
    converted = False

    try:
        if ext != ".avif" and shutil.which("cwebp"):
            res = subprocess.run(
                ["cwebp", "-quiet", "-q", str(quality), "-mt", str(src_path), "-o", str(tmp_webp)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if res.returncode == 0 and tmp_webp.is_file() and tmp_webp.stat().st_size > 0:
                converted = True

        if not converted and HAS_PILLOW:
            try:
                with Image.open(src_path) as im:
                    im = ImageOps.exif_transpose(im)
                    if im.mode not in ("RGB", "RGBA"):
                        im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
                    im.save(tmp_webp, "WEBP", quality=quality, method=4)
                if tmp_webp.is_file() and tmp_webp.stat().st_size > 0:
                    converted = True
            except Exception:
                pass

        if not converted and shutil.which("ffmpeg"):
            res = subprocess.run(
                [
                    "ffmpeg", "-y", "-v", "error",
                    "-i", str(src_path),
                    "-frames:v", "1",
                    "-c:v", "libwebp",
                    "-q:v", str(quality),
                    str(tmp_webp),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if res.returncode == 0 and tmp_webp.is_file() and tmp_webp.stat().st_size > 0:
                converted = True

        if converted and tmp_webp.is_file():
            new_size = tmp_webp.stat().st_size
            if new_size > 0 and (ext == ".avif" or new_size < orig_size):
                src_path.unlink(missing_ok=True)
                tmp_webp.rename(dest_webp)
                return dest_webp
    except OSError:
        pass
    finally:
        tmp_webp.unlink(missing_ok=True)

    return src_path


class ModuleFileIndex:
    """Szybki indeks plików wewnątrz katalogu modułu (z pominięciem folderów miniatur)."""

    def __init__(self, module_dir: Path):
        self.module_dir = module_dir
        self.by_rel_lower = {}
        self.by_rel_stem_lower = {}
        self.by_filename_lower = {}
        self.by_stem_lower = {}

        for p in sorted(module_dir.rglob("*")):
            if not p.is_file():
                continue
            rel_parts = p.relative_to(module_dir).parts
            if is_thumb_dir_part(rel_parts):
                continue

            rel_posix = p.relative_to(module_dir).as_posix()
            rel_stem_posix = p.relative_to(module_dir).with_suffix("").as_posix()
            self.by_rel_lower[rel_posix.lower()] = p
            self.by_rel_stem_lower[rel_stem_posix.lower()] = p

            fname_lower = p.name.lower()
            if fname_lower not in self.by_filename_lower:
                self.by_filename_lower[fname_lower] = p

            stem_lower = p.stem.lower()
            if stem_lower not in self.by_stem_lower or p.suffix.lower() in IMAGE_EXTS:
                self.by_stem_lower[stem_lower] = p

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

        if not parts or is_thumb_dir_part(tuple(parts[:-1])):
            return None

        candidate = self.module_dir.joinpath(*parts)
        if candidate.is_file():
            return candidate

        rel_key = "/".join(parts).lower()
        if rel_key in self.by_rel_lower:
            return self.by_rel_lower[rel_key]

        rel_stem_key = str(Path(rel_key).with_suffix("")).replace("\\", "/")
        if rel_stem_key in self.by_rel_stem_lower:
            return self.by_rel_stem_lower[rel_stem_key]

        fname_lower = parts[-1].lower()
        if fname_lower in self.by_filename_lower:
            return self.by_filename_lower[fname_lower]

        stem_lower = Path(parts[-1]).stem.lower()
        return self.by_stem_lower.get(stem_lower)


# ---------------------------------------------------------
#  Wbudowany czytnik LevelDB (Foundry v11-v14 Compendiums)
# ---------------------------------------------------------

def _read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while pos < len(buf):
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
    return result, pos


def _snappy_decompress(buf: bytes) -> bytes:
    _, pos = _read_varint(buf, 0)
    out = bytearray()
    n = len(buf)
    while pos < n:
        tag = buf[pos]
        pos += 1
        tag_type = tag & 0x03
        if tag_type == 0:
            length = (tag >> 2) + 1
            if length > 60:
                extra = length - 60
                length = int.from_bytes(buf[pos:pos + extra], "little") + 1
                pos += extra
            out.extend(buf[pos:pos + length])
            pos += length
        else:
            if tag_type == 1:
                length = ((tag >> 2) & 0x07) + 4
                offset = ((tag & 0xE0) << 3) | buf[pos]
                pos += 1
            elif tag_type == 2:
                length = (tag >> 2) + 1
                offset = int.from_bytes(buf[pos:pos + 2], "little")
                pos += 2
            else:
                length = (tag >> 2) + 1
                offset = int.from_bytes(buf[pos:pos + 4], "little")
                pos += 4
            if offset <= 0 or offset > len(out):
                break
            start = len(out) - offset
            for i in range(length):
                out.append(out[start + i])
    return bytes(out)


def _iter_leveldb_block_entries(block_bytes: bytes):
    if len(block_bytes) < 4:
        return
    num_restarts = struct.unpack("<I", block_bytes[-4:])[0]
    limit = len(block_bytes) - 4 - (num_restarts * 4)
    if limit <= 0:
        return
    pos = 0
    last_key = b""
    while pos < limit:
        shared, pos = _read_varint(block_bytes, pos)
        non_shared, pos = _read_varint(block_bytes, pos)
        val_len, pos = _read_varint(block_bytes, pos)
        if pos + non_shared + val_len > limit:
            break
        key_delta = block_bytes[pos:pos + non_shared]
        pos += non_shared
        val = block_bytes[pos:pos + val_len]
        pos += val_len
        last_key = last_key[:shared] + key_delta
        if len(last_key) >= 8:
            user_key = last_key[:-8]
            val_type = last_key[-8]
            yield user_key, val_type, val


def _read_leveldb_ldb_file(ldb_path: Path) -> dict[bytes, bytes]:
    kv = {}
    data = ldb_path.read_bytes()
    if len(data) < 48 or data[-8:] != b"\x57\xfb\x80\x8b\x24\x75\x47\xdb":
        return kv
    footer = data[-48:-8]
    _, pos = _read_varint(footer, 0)
    _, pos = _read_varint(footer, pos)
    idx_offset, pos = _read_varint(footer, pos)
    idx_size, pos = _read_varint(footer, pos)

    if idx_offset + idx_size + 5 > len(data):
        return kv
    idx_raw = data[idx_offset:idx_offset + idx_size]
    comp_type = data[idx_offset + idx_size]
    if comp_type == 1:
        idx_raw = _snappy_decompress(idx_raw)

    for _, _, handle_bytes in _iter_leveldb_block_entries(idx_raw):
        b_offset, h_pos = _read_varint(handle_bytes, 0)
        b_size, _ = _read_varint(handle_bytes, h_pos)
        if b_offset + b_size + 5 > len(data):
            continue
        b_raw = data[b_offset:b_offset + b_size]
        b_comp = data[b_offset + b_size]
        if b_comp == 1:
            b_raw = _snappy_decompress(b_raw)
        for ukey, vtype, val in _iter_leveldb_block_entries(b_raw):
            if vtype == 1:
                kv[ukey] = val
            elif vtype == 0:
                kv.pop(ukey, None)
    return kv


def _read_leveldb_log_file(log_path: Path) -> dict[bytes, bytes]:
    kv = {}
    data = log_path.read_bytes()
    block_size = 32768
    pos = 0
    frag = bytearray()
    while pos < len(data):
        rem = block_size - (pos % block_size)
        if rem < 7:
            pos += rem
            continue
        if pos + 7 > len(data):
            break
        _, length, rtype = struct.unpack("<IHB", data[pos:pos + 7])
        pos += 7
        if pos + length > len(data):
            break
        chunk = data[pos:pos + length]
        pos += length
        if rtype == 1:
            frag = bytearray(chunk)
        elif rtype == 2:
            frag = bytearray(chunk)
            continue
        elif rtype == 3:
            frag.extend(chunk)
            continue
        elif rtype == 4:
            frag.extend(chunk)
        else:
            continue

        batch = bytes(frag)
        frag.clear()
        if len(batch) < 12:
            continue
        b_pos = 12
        while b_pos < len(batch):
            vtype = batch[b_pos]
            b_pos += 1
            klen, b_pos = _read_varint(batch, b_pos)
            key = batch[b_pos:b_pos + klen]
            b_pos += klen
            if vtype == 1:
                vlen, b_pos = _read_varint(batch, b_pos)
                val = batch[b_pos:b_pos + vlen]
                b_pos += vlen
                kv[key] = val
            elif vtype == 0:
                kv.pop(key, None)
    return kv


def extract_scenes_from_leveldb_dir(pack_dir: Path) -> list[dict]:
    kv: dict[bytes, bytes] = {}
    for ldb_file in sorted(pack_dir.glob("*.ldb")) + sorted(pack_dir.glob("*.sst")):
        try:
            kv.update(_read_leveldb_ldb_file(ldb_file))
        except Exception:
            pass
    for log_file in sorted(pack_dir.glob("*.log")):
        try:
            kv.update(_read_leveldb_log_file(log_file))
        except Exception:
            pass

    scenes_by_id: dict[str, dict] = {}
    subdocs: list[tuple[str, str, dict]] = []

    for raw_k, raw_v in kv.items():
        if not raw_k.startswith(b"!scenes"):
            continue
        try:
            key_str = raw_k.decode("utf-8", errors="ignore")
            doc = json.loads(raw_v.decode("utf-8", errors="ignore"))
            if not isinstance(doc, dict):
                continue
        except Exception:
            continue

        if key_str.startswith("!scenes!"):
            scene_id = key_str.split("!", 2)[2]
            scenes_by_id[scene_id] = doc
        elif key_str.startswith("!scenes."):
            rest = key_str[len("!scenes."):]
            if "!" in rest:
                sub_type, id_part = rest.split("!", 1)
                scene_id = id_part.split(".", 1)[0]
                subdocs.append((scene_id, sub_type, doc))

    for scene_id, sub_type, sub_doc in subdocs:
        parent = scenes_by_id.get(scene_id)
        if parent is not None and sub_type in ("walls", "lights", "tiles", "tokens", "sounds", "notes", "drawings", "levels"):
            if not isinstance(parent.get(sub_type), list):
                parent[sub_type] = []
            parent[sub_type].append(sub_doc)

    return [s for s in scenes_by_id.values() if is_scene_doc(s)]


# ---------------------------------------------------------
#  Ekstrakcja i normalizacja scen
# ---------------------------------------------------------

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


def is_scene_doc(doc: dict) -> bool:
    if not isinstance(doc, dict):
        return False
    has_scene_structure = any(k in doc for k in ("walls", "lights", "tiles", "drawings", "levels"))
    has_image = bool(extract_bg_from_raw_scene(doc) or doc.get("foreground"))
    return (has_scene_structure or ("width" in doc and "height" in doc and "grid" in doc)) and has_image


def extract_raw_scenes_from_source(src_dir: Path):
    """Wykrywa sceny z scenes.json, baz NeDB (packs/*.db) lub baz LevelDB (packs/*/*.ldb)."""
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
        return scenes, f"NeDB: {', '.join(matched_dbs)}"

    ldb_dirs = sorted({
        p.parent for p in src_dir.rglob("CURRENT")
        if (p.parent / "MANIFEST-000001").exists() or list(p.parent.glob("*.ldb")) or list(p.parent.glob("*.log"))
    })
    matched_ldbs = []
    for ldb_dir in ldb_dirs:
        ldb_scenes = extract_scenes_from_leveldb_dir(ldb_dir)
        if ldb_scenes:
            scenes.extend(ldb_scenes)
            matched_ldbs.append(ldb_dir.name)

    if scenes:
        return scenes, f"LevelDB: {', '.join(matched_ldbs)}"

    return [], None


def normalize_subasset_paths(raw: dict, file_index: ModuleFileIndex, module_id: str, used_files: set[Path]):
    def to_canonical(path_str: str) -> str:
        resolved = file_index.resolve(path_str)
        if resolved:
            used_files.add(resolved.resolve())
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

    if src_image.suffix.lower() != ".avif" and shutil.which("cwebp"):
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


def peek_zip_manifest(zip_path: Path) -> dict:
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
    if (src_dir / "module.json").is_file() or (src_dir / "scenes.json").is_file():
        return src_dir
    mod_jsons = sorted(
        [p for p in src_dir.rglob("module.json") if len(p.relative_to(src_dir).parts) <= 3],
        key=lambda p: len(p.relative_to(src_dir).parts)
    )
    if mod_jsons:
        return mod_jsons[0].parent
    return src_dir


def prune_unused_files_in_module(tmp_dir: Path, used_files: set[Path]):
    """Usuwa z kopii modułu nieużywane pliki (bazy packs/, stare miniatury thumbs/, duplikaty z siatką, PDF-y)."""
    thumbs_dir = (tmp_dir / "_thumbs").resolve()
    keep_meta = {(tmp_dir / "scenes.json").resolve(), (tmp_dir / "module.json").resolve()}

    removed_bytes = 0
    for p in list(tmp_dir.rglob("*")):
        if not p.is_file():
            continue
        rp = p.resolve()
        if rp in keep_meta or rp in used_files or thumbs_dir in rp.parents:
            continue
        try:
            removed_bytes += p.stat().st_size
            p.unlink(missing_ok=True)
        except Exception:
            pass

    for d in sorted([p for p in tmp_dir.rglob("*") if p.is_dir()], key=lambda x: len(x.parts), reverse=True):
        if d.resolve() == thumbs_dir:
            continue
        try:
            if not any(d.iterdir()):
                d.rmdir()
        except Exception:
            pass

    return removed_bytes


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
        if source_type:
            print(f"[INFO] Wykryto źródło scen: {source_type} ({len(raw_scenes)} scen)")

        if not args.no_webp_convert:
            to_convert = [
                p for p in tmp_dir.rglob("*")
                if p.is_file()
                and not is_thumb_dir_part(p.relative_to(tmp_dir).parts)
                and (
                    p.suffix.lower() in (".avif", ".png")
                    or (args.convert_jpg and p.suffix.lower() in (".jpg", ".jpeg"))
                )
            ]
            if to_convert:
                print(f"[OPTYMALIZACJA] Konwersja {len(to_convert)} plików do .webp (jakość={args.quality})...")
                with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
                    list(pool.map(lambda p: convert_image_to_webp(p, quality=args.quality), to_convert))

        all_images = sorted([
            p for p in tmp_dir.rglob("*")
            if p.is_file()
            and p.suffix.lower() in IMAGE_EXTS
            and not is_thumb_dir_part(p.relative_to(tmp_dir).parts)
        ])

        thumbs_dir = tmp_dir / "_thumbs"
        thumbs_dir.mkdir(exist_ok=True)

        file_index = ModuleFileIndex(tmp_dir)
        normalized_scenes = []
        thumb_tasks = []
        used_files: set[Path] = set()
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

                used_files.add(resolved_file.resolve())
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

                normalize_subasset_paths(raw, file_index, module_id, used_files)

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
                raise RuntimeError("Nie znaleziono żadnych plików graficznych (.jpg/.png/.webp/.avif).")

            for img_src in all_images:
                used_files.add(img_src.resolve())
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

        freed_bytes = prune_unused_files_in_module(tmp_dir, used_files)
        freed_mb = freed_bytes / (1024 * 1024)

        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        tmp_dir.rename(dest_dir)

        print(
            f"[SUKCES] {module_id} ('{title}') -> scen: {len(normalized_scenes)} | "
            f"pominięto: {skipped_scenes} | oczyszczono zbędnych danych: {freed_mb:.1f} MB"
        )

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
    parser = argparse.ArgumentParser(description="Skrypt A: Uniwersalna normalizacja i optymalizacja modułów map.")
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
        help="Tryb wsadowy: znajdź i przetwórz wszystkie pliki .zip oraz podfoldery wewnątrz --input.",
    )
    parser.add_argument("--skip-existing", action="store_true", help="Pomiń moduły, które już istnieją w katalogu docelowym.")
    parser.add_argument("--overwrite", action="store_true", help="Nadpisz istniejące moduły bez pytania.")
    parser.add_argument("--delete-source-zip", action="store_true", help="Usuń źródłowy plik .zip po udanej normalizacji.")
    parser.add_argument("--no-webp-convert", action="store_true", help="Nie konwertuj plików .avif/.png do .webp.")
    parser.add_argument("--convert-jpg", action="store_true", help="Konwertuj również pliki .jpg do .webp.")
    parser.add_argument(
        "--quality", "-q",
        type=int,
        default=90,
        help="Jakość konwersji WebP dla pełnych map (domyślnie: 90).",
    )
    parser.add_argument(
        "--workers", "-w",
        type=int,
        default=min(8, os.cpu_count() or 4),
        help="Liczba wątków generowania miniatur i konwersji WebP.",
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
        sub_dirs = sorted([
            d for d in input_path.iterdir()
            if d.is_dir() and not d.name.startswith(".") and not any(d.rglob("*.zip"))
        ])
        targets = zip_files + sub_dirs
        print(f"[BATCH] Znaleziono {len(zip_files)} archiwów .zip oraz {len(sub_dirs)} podfolderów w: {input_path}")

        ok_cnt = 0
        fail_cnt = 0
        for idx, target in enumerate(targets, 1):
            print(f"\n--- [{idx} / {len(targets)}] {target.name} ---")
            if process_single_item(target, out_root, args):
                ok_cnt += 1
            else:
                fail_cnt += 1

        print("\n=== Podsumowanie wsadowe (Batch) ===")
        print(f" * Przetworzono pomyślnie: {ok_cnt}")
        print(f" * Błędy / pominięte:      {fail_cnt}")
        if fail_cnt > 0:
            sys.exit(1)
    else:
        if not process_single_item(input_path, out_root, args):
            sys.exit(1)


if __name__ == "__main__":
    main()
