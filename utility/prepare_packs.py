#!/usr/bin/env python3
"""
Skrypt przygotowujący paczki map pod normalize_module.py:
1. Dla paczek z plikiem manifestu Foundry VTT (Ready-to-play / manifest url.txt / Manifeft URL.txt):
   pobiera moduł(y) .zip do katalogu wyjściowego, weryfikuje archiwum ZIP i usuwa cały oryginalny folder paczki.
2. Dla paczek bez manifestu Foundry VTT:
   odrzuca pliki .dd2vtt, statblocki, paczki assetów oraz mapy z siatką (GRID / Grd / GRD),
   zostawiając tylko mapy bez siatki (NG / GL / Gridless) i przenosi je (0 dodatkowego miejsca na dysku)
   do czystego folderu paczki w katalogu wyjściowym.
"""

import argparse
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".avif"}

IGNORED_SUBFOLDER_KEYWORDS = (
    "statblock",
    "stat block",
    "asset pack",
    "dd asset",
)

IGNORED_DOMAINS = (
    "patreon.com/posts",
    "patreon.com/c/",
    "patreon.com/cw/",
    "instagram.com",
    "twitter.com",
    "x.com",
    "facebook.com",
    "discord.gg",
    "discord.com/invite",
    "roll20.net",
)

NG_REGEX = re.compile(
    r"(?:^|[\s_\-\(\[\.]|(?<=lighting))(ng|gl|no[\s_\-]?grid|gridless|ungridded)(?=[\s_\-\)\]\.]|webp|jpg|png|avif|$)",
    re.IGNORECASE,
)

GRID_REGEX = re.compile(
    r"(?:^|[\s_\-\(\[\.]|(?<=v\d))(grid|grd|gridded)(?=[\s_\-\)\]\.]|webp|jpg|png|avif|$)",
    re.IGNORECASE,
)

URL_REGEX = re.compile(r"https?://[^\s<>\"'\)\]]+", re.IGNORECASE)


def sanitize_name(name: str) -> str:
    cleaned = re.sub(r"[<>:\"/\\|?*]+", " ", name).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned or "Map Pack"


def slugify(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9-_]+", "-", name.lower()).strip("-") or "map-pack"


def is_ignored_subfolder(rel_parts: tuple[str, ...]) -> bool:
    for part in rel_parts[:-1]:
        pl = part.lower()
        if any(kw in pl for kw in IGNORED_SUBFOLDER_KEYWORDS):
            return True
    return False


def is_ng_filename(stem: str) -> bool:
    return bool(NG_REGEX.search(stem))


def is_grid_filename(stem: str) -> bool:
    if is_ng_filename(stem):
        return False
    return bool(GRID_REGEX.search(stem))


def strip_grid_ng_tokens(stem: str) -> str:
    s = re.sub(r"(?i)(ng|grid)webp$", r"\1", stem)
    s = NG_REGEX.sub(" ", s)
    s = GRID_REGEX.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip(" _-()")
    return s or stem


def normalize_download_url(url: str) -> str:
    url = url.strip().rstrip(".,;)")
    if "dropbox.com" in url and "dl=0" in url:
        url = url.replace("dl=0", "dl=1")
    elif "dropbox.com" in url and "dl=" not in url:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}dl=1"
    return url


def find_manifest_urls_in_pack(pack_dir: Path) -> list[str]:
    candidate_files = []
    for p in sorted(pack_dir.rglob("*")):
        if not p.is_file():
            continue
        name_lower = p.name.lower()
        rel_lower = p.relative_to(pack_dir).as_posix().lower()
        if p.suffix.lower() in (".txt", ".json", ".url", ".md"):
            if (
                "manifest" in name_lower
                or "manifeft" in name_lower
                or "ready-to-play" in rel_lower
                or "ready to play" in rel_lower
                or "ready_to_play" in rel_lower
                or "manifest url" in rel_lower
            ):
                candidate_files.append(p)

    urls = []
    seen = set()
    for tf in candidate_files:
        try:
            content = tf.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        for match in URL_REGEX.findall(content):
            u = normalize_download_url(match)
            if any(dom in u.lower() for dom in IGNORED_DOMAINS):
                continue
            if u not in seen:
                seen.add(u)
                urls.append(u)

    return urls


def download_foundry_zip(url: str, output_dir: Path, fallback_slug: str) -> Path | None:
    headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) FoundryMapPrep/1.0"}
    req = urllib.request.Request(url, headers=headers)
    tmp_part = output_dir / f".download_{fallback_slug}.part"

    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(req, timeout=60) as resp:
            first_chunk = resp.read(8192)
            if not first_chunk:
                return None

            if first_chunk.startswith(b"PK\x03\x04"):
                final_zip = output_dir / f"{fallback_slug}.zip"
                with tmp_part.open("wb") as out_f:
                    out_f.write(first_chunk)
                    shutil.copyfileobj(resp, out_f)
            else:
                raw_bytes = first_chunk + resp.read(2 * 1024 * 1024)
                text_data = raw_bytes.decode("utf-8", errors="ignore").strip().lstrip("\ufeff")
                manifest = json.loads(text_data)

                dl_url = manifest.get("download")
                if not dl_url or not isinstance(dl_url, str):
                    print(f"    [!] Manifest nie zawiera pola 'download': {url}")
                    return None

                dl_url = urllib.parse.urljoin(url, dl_url.strip())
                dl_url = normalize_download_url(dl_url)

                mod_id = slugify(str(manifest.get("id") or manifest.get("name") or fallback_slug))
                final_zip = output_dir / f"{mod_id}.zip"

                if final_zip.is_file() and zipfile.is_zipfile(final_zip):
                    print(f"    [OK] Moduł {final_zip.name} jest już pobrany.")
                    return final_zip

                print(f"    -> Pobieranie archiwum modułu '{mod_id}': {dl_url}")
                dl_req = urllib.request.Request(dl_url, headers=headers)
                with urllib.request.urlopen(dl_req, timeout=180) as dl_resp, tmp_part.open("wb") as out_f:
                    shutil.copyfileobj(dl_resp, out_f)

        if tmp_part.is_file() and zipfile.is_zipfile(tmp_part):
            tmp_part.rename(final_zip)
            return final_zip
        else:
            tmp_part.unlink(missing_ok=True)
            print(f"    [!] Pobrany plik z {url} nie jest poprawnym archiwum ZIP.")
            return None

    except Exception as e:
        tmp_part.unlink(missing_ok=True)
        print(f"    [!] Błąd pobierania z {url}: {e}")
        return None


def select_gridless_images_in_folder(images: list[Path]) -> list[Path]:
    ng_files = []
    grid_files = []
    neutral_files = []

    for img in images:
        if is_ng_filename(img.stem):
            ng_files.append(img)
        elif is_grid_filename(img.stem):
            grid_files.append(img)
        else:
            neutral_files.append(img)

    if ng_files:
        return ng_files
    if neutral_files:
        return neutral_files
    return images


def process_pack(pack_dir: Path, output_dir: Path, dry_run: bool = False, keep_source: bool = False):
    pack_name = sanitize_name(pack_dir.name)
    pack_slug = slugify(pack_name)
    print(f"\n=== [{pack_dir.parent.name} / {pack_dir.name}] ===")

    manifest_urls = find_manifest_urls_in_pack(pack_dir)
    if manifest_urls:
        if dry_run:
            for u in manifest_urls:
                print(f" [DRY-RUN MANIFEST] Pobrano by moduł Foundry z: {u}")
            print(f" [DRY-RUN CLEANUP]  Po pobraniu usunięto by folder: {pack_dir}")
            return

        downloaded_any = False
        all_succeeded = True
        for idx, u in enumerate(manifest_urls, 1):
            sub_slug = pack_slug if len(manifest_urls) == 1 else f"{pack_slug}-{idx}"
            print(f" -> Sprawdzanie manifestu ({idx}/{len(manifest_urls)}): {u}")
            saved_zip = download_foundry_zip(u, output_dir, sub_slug)
            if saved_zip:
                downloaded_any = True
                print(f" [SUKCES ZIP] Zapisano: {saved_zip.name}")
            else:
                all_succeeded = False

        if downloaded_any and all_succeeded:
            if not keep_source:
                shutil.rmtree(pack_dir)
                print(f" [CLEANUP] Usunięto oryginalne pliki .dd2vtt i obrazy z: {pack_dir.name}")
            return
        elif downloaded_any and not all_succeeded:
            print(" [!] Część linków w paczce nie zadziałała — zachowuję pozostałe surowe obrazy NG.")
        else:
            print(" [!] Nie udało się pobrać modułu z manifestu — przechodzę do ekstrakcji surowych map NG.")

    by_subfolder: dict[Path, list[Path]] = {}
    total_found = 0

    for p in sorted(pack_dir.rglob("*")):
        if not p.is_file():
            continue
        if p.name.endswith("~") or ".dd2vtt" in p.name.lower():
            continue
        if p.suffix.lower() not in IMAGE_EXTS:
            continue
        rel_parts = p.relative_to(pack_dir).parts
        if is_ignored_subfolder(rel_parts):
            continue

        total_found += 1
        by_subfolder.setdefault(p.parent, []).append(p)

    selected_images: list[Path] = []
    for folder_path, imgs in sorted(by_subfolder.items()):
        selected_images.extend(select_gridless_images_in_folder(imgs))

    if not selected_images:
        print(f" [POMINIĘTO] Brak map do zaimportowania w: {pack_dir.name}")
        return

    target_pack_dir = output_dir / pack_name

    if dry_run:
        print(
            f" [DRY-RUN SUROWE MAPY] Znaleziono obrazów: {total_found} -> "
            f"Wybrano bez siatki (NG): {len(selected_images)} szt. -> '{target_pack_dir.name}'"
        )
        return

    target_pack_dir.mkdir(parents=True, exist_ok=True)
    existing_names = {p.name.lower() for p in target_pack_dir.iterdir() if p.is_file()}

    moved_count = 0
    for img in selected_images:
        clean_stem = strip_grid_ng_tokens(img.stem)
        ext = img.suffix.lower()
        candidate_name = f"{clean_stem}{ext}"

        if candidate_name.lower() in existing_names:
            sub_name = sanitize_name(img.parent.name)
            if sub_name.lower() not in (pack_name.lower(), "battle maps", "regional maps", "world & regional maps"):
                candidate_name = f"{sub_name} - {clean_stem}{ext}"

        idx = 2
        final_name = candidate_name
        while final_name.lower() in existing_names:
            final_name = f"{Path(candidate_name).stem} ({idx}){ext}"
            idx += 1

        existing_names.add(final_name.lower())
        dest_file = target_pack_dir / final_name

        if keep_source:
            shutil.copy2(img, dest_file)
        else:
            shutil.move(str(img), str(dest_file))
        moved_count += 1

    if not keep_source:
        shutil.rmtree(pack_dir)

    print(
        f" [SUKCES NG] Przeniesiono {moved_count} map bez siatki do '{target_pack_dir.name}' "
        f"(usunięto {total_found - moved_count} map z siatką oraz pliki .dd2vtt)"
    )


def discover_pack_dirs(inputs: list[str]) -> list[Path]:
    pack_dirs = []
    for raw_in in inputs:
        p = Path(raw_in).resolve()
        if not p.is_dir():
            print(f"[!] Pominięto nieistniejący katalog: {p}")
            continue
        for child in sorted(p.iterdir()):
            if child.is_dir() and not child.name.startswith("."):
                pack_dirs.append(child)
    return pack_dirs


def main():
    parser = argparse.ArgumentParser(description="Przygotowuje drzewo paczek map pod normalize_module.py.")
    parser.add_argument(
        "--inputs", "-i",
        nargs="+",
        default=["./Sage2025", "./Sage2026"],
        help="Lista głównych katalogów z paczkami (domyślnie: ./Sage2025 ./Sage2026).",
    )
    parser.add_argument(
        "--output", "-o",
        default="./ready_to_normalize",
        help="Pojedynczy katalog docelowy dla przygotowanych paczek (domyślnie: ./ready_to_normalize).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Pokaż plan działania bez pobierania i bez usuwania plików.")
    parser.add_argument("--keep-source", action="store_true", help="Zachowaj pliki źródłowe (domyślnie usuwa po przetworzeniu).")
    args = parser.parse_args()

    output_dir = Path(args.output).resolve()
    pack_dirs = discover_pack_dirs(args.inputs)

    if not pack_dirs:
        print("[BŁĄD] Nie znaleziono żadnych folderów paczek w podanych ścieżkach.")
        sys.exit(1)

    print(f"[START] Znaleziono łącznie {len(pack_dirs)} paczek do przygotowania.")
    for pack_dir in pack_dirs:
        if pack_dir.resolve() == output_dir:
            continue
        process_pack(pack_dir, output_dir, dry_run=args.dry_run, keep_source=args.keep_source)

    print(f"\n[GOTOWE] Wszystkie paczki są przygotowane w: {output_dir}")


if __name__ == "__main__":
    main()
