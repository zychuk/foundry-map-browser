#!/usr/bin/env python3
"""
Skrypt B: Bezpieczna aktualizacja pliku catalog.json.
- Skanuje katalog modules/ i wykrywa nowe moduły (oraz opcjonalnie aktualizuje istniejące).
- Tworzy kopię zapasową catalog.json przed jakąkolwiek zmianą.
- Nie duplikuje wpisów (sprawdza po moduleId oraz parze tytuł+kategoria).
- Dla nowych (oraz opcjonalnie uszkodzonych) modułów automatycznie ustawia jako okładkę
  pierwszy istniejący plik graficzny w folderze _thumbs/ (o ile nie podano jawnie poprawnej ścieżki).
- Przed zapisem sortuje paczki deterministycznie, weryfikuje składnię JSON i zapisuje plik atomowo.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

IMAGE_EXTS = {".webp", ".jpg", ".jpeg", ".png", ".avif"}


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


def extract_bg_from_scene(r: dict) -> str | None:
    if not isinstance(r, dict):
        return None
    bg = (r.get("background") or {}).get("src") if isinstance(r.get("background"), dict) else None
    if bg:
        return bg
    if r.get("img"):
        return r.get("img")
    levels = r.get("levels")
    if isinstance(levels, list) and levels and isinstance(levels[0], dict):
        lvl_bg = (levels[0].get("background") or {}).get("src") if isinstance(levels[0].get("background"), dict) else None
        if lvl_bg:
            return lvl_bg
    return r.get("bg")


def find_first_thumbnail_in_module(root_dir: Path, module_dir: Path, scenes_list: list) -> str:
    thumbs_dir = module_dir / "_thumbs"
    if thumbs_dir.is_dir():
        files = sorted([p for p in thumbs_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS])
        if files:
            return files[0].relative_to(root_dir).as_posix()

    for s in scenes_list:
        for candidate in (s.get("thumb"), s.get("bg")):
            if candidate and (root_dir / candidate).is_file():
                return candidate

    all_imgs = sorted([p for p in module_dir.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTS])
    if all_imgs:
        return all_imgs[0].relative_to(root_dir).as_posix()

    return ""


def resolve_scene_thumb(root_dir: Path, module_id: str, raw_thumb: str | None, bg: str) -> str:
    if raw_thumb and (root_dir / raw_thumb).is_file():
        return raw_thumb

    bg_path = Path(bg)
    parts = bg_path.parts
    rel_inside_mod = "/".join(parts[2:]) if len(parts) > 2 and parts[0].lower() == "modules" else bg
    rel_hash = hashlib.md5(rel_inside_mod.encode("utf-8")).hexdigest()[:8]

    hashed_candidate = f"modules/{module_id}/_thumbs/{bg_path.stem}_{rel_hash}.webp"
    if (root_dir / hashed_candidate).is_file():
        return hashed_candidate

    plain_candidate = f"modules/{module_id}/_thumbs/{bg_path.stem}.webp"
    if (root_dir / plain_candidate).is_file():
        return plain_candidate

    return bg


def build_pack_entry(root_dir: Path, module_dir: Path, non_interactive: bool = False):
    module_id = module_dir.name
    scenes_json_path = module_dir / "scenes.json"

    if not scenes_json_path.is_file():
        return None, "brak pliku scenes.json (użyj najpierw Skryptu A)"

    try:
        raw_scenes = json.loads(scenes_json_path.read_text(encoding="utf-8"))
    except Exception as e:
        return None, f"błąd odczytu scenes.json ({e})"

    if not isinstance(raw_scenes, list) or not raw_scenes:
        return None, "pusta lista scen w scenes.json"

    manifest = {}
    manifest_path = module_dir / "module.json"
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    title = manifest.get("title")
    if not title:
        default_title = module_id.replace("-", " ").replace("_", " ").title()
        title = ask_user(f"Brak tytułu dla '{module_id}'. Podaj tytuł", default_title, non_interactive)

    version = str(manifest.get("version") or "1.0.0")
    category = manifest.get("category")
    if category not in ("map", "scene"):
        default_cat = "scene" if "scene" in module_id.lower() or "scene" in title.lower() else "map"
        category = ask_user(
            f"Typ modułu '{module_id}' ('map' lub 'scene')", default_cat, non_interactive
        ).lower()
        if category not in ("map", "scene"):
            category = "map"

    catalog_scenes = []
    for r in raw_scenes:
        s_id = r.get("_id") or r.get("id")
        s_name = r.get("name") or "Scena"
        bg = extract_bg_from_scene(r)
        if not bg:
            continue

        if not (root_dir / bg).is_file():
            print(f"   [!] Pominięto scenę '{s_name}' w '{module_id}' (brak pliku: {bg})")
            continue

        thumb = resolve_scene_thumb(root_dir, module_id, r.get("thumb"), bg)

        catalog_scenes.append({
            "id": s_id,
            "name": s_name,
            "width": int(r.get("width") or 4000),
            "height": int(r.get("height") or 3000),
            "thumb": thumb,
            "bg": bg
        })

    if not catalog_scenes:
        return None, "brak poprawnych scen z istniejącymi plikami na dysku"

    explicit_cover = manifest.get("cover")
    if explicit_cover and (root_dir / explicit_cover).is_file():
        cover = explicit_cover
    else:
        cover = find_first_thumbnail_in_module(root_dir, module_dir, catalog_scenes)

    entry = {
        "moduleId": module_id,
        "title": title,
        "category": category,
        "cover": cover,
        "sceneCount": len(catalog_scenes),
        "scenes": catalog_scenes,
        "version": version
    }
    return entry, None


def main():
    parser = argparse.ArgumentParser(description="Skrypt B: Bezpieczna aktualizacja catalog.json.")
    parser.add_argument(
        "--root",
        "-r",
        default="/srv/data/foundry-maps",
        help="Główny katalog serwera map (domyślnie: /srv/data/foundry-maps).",
    )
    parser.add_argument(
        "--fix-missing-covers",
        action="store_true",
        help="Napraw również brakujące okładki (cover) w już istniejących wpisach catalog.json.",
    )
    parser.add_argument(
        "--update-existing",
        action="store_true",
        help="Odśwież wpisy modułów, które już istnieją w catalog.json, jeśli zmieniły się ich sceny lub metadane.",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="Usuń z catalog.json wpisy modułów, których katalogi nie istnieją już na dysku.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Pokaż zmiany bez modyfikowania catalog.json.")
    parser.add_argument("--non-interactive", action="store_true", help="Nie pytaj w konsoli, użyj wartości domyślnych.")
    args = parser.parse_args()

    root_dir = Path(args.root).resolve()
    modules_dir = root_dir / "modules"
    catalog_path = root_dir / "catalog.json"

    if not modules_dir.is_dir():
        print(f"[BŁĄD] Katalog modułów nie istnieje: {modules_dir}")
        sys.exit(1)

    if catalog_path.is_file():
        try:
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[BŁĄD KRYTYCZNY] Obecny plik catalog.json jest uszkodzony i nie zostanie nadpisany: {e}")
            sys.exit(1)
    else:
        catalog = {"totalPacks": 0, "packs": []}

    existing_packs = catalog.get("packs", [])
    pruned_count = 0

    if args.prune:
        kept_packs = []
        for p in existing_packs:
            mod_id = p.get("moduleId")
            if mod_id and (modules_dir / mod_id).is_dir():
                kept_packs.append(p)
            else:
                pruned_count += 1
                print(f"[USUNIĘTO WPIS] {mod_id} (brak katalogu na dysku)")
        existing_packs = kept_packs

    existing_by_id = {p.get("moduleId", "").lower(): idx for idx, p in enumerate(existing_packs) if p.get("moduleId")}
    existing_title_cats = {
        (p.get("title", "").lower(), p.get("category", "map"))
        for p in existing_packs
        if p.get("title")
    }

    fixed_covers_count = 0
    if args.fix_missing_covers:
        for p in existing_packs:
            mod_id = p.get("moduleId")
            cov = p.get("cover")
            if not cov or not (root_dir / cov).is_file():
                mod_folder = modules_dir / mod_id
                new_cov = find_first_thumbnail_in_module(root_dir, mod_folder, p.get("scenes", []))
                if new_cov and new_cov != cov:
                    p["cover"] = new_cov
                    fixed_covers_count += 1
                    print(f"[NAPRAWIONO COVER] {mod_id} -> {new_cov}")
            p["sceneCount"] = len(p.get("scenes", []))

    added_packs = []
    updated_packs = []
    skipped_modules = []

    for mod_dir in sorted([d for d in modules_dir.iterdir() if d.is_dir() and not d.name.startswith(".")]):
        mod_id = mod_dir.name
        mod_key = mod_id.lower()

        if mod_key in existing_by_id:
            if not args.update_existing:
                continue

            entry, reason = build_pack_entry(root_dir, mod_dir, args.non_interactive)
            if not entry:
                skipped_modules.append((mod_id, reason))
                continue

            idx = existing_by_id[mod_key]
            old_entry = existing_packs[idx]
            if old_entry != entry:
                existing_packs[idx] = entry
                updated_packs.append(entry)
                print(f"[ZAKTUALIZOWANO] {entry['moduleId']} (scen: {entry['sceneCount']}, v{entry['version']})")
            continue

        entry, reason = build_pack_entry(root_dir, mod_dir, args.non_interactive)
        if not entry:
            skipped_modules.append((mod_id, reason))
            continue

        title_cat_key = (entry["title"].lower(), entry["category"])
        if title_cat_key in existing_title_cats:
            print(f"[UWAGA] Moduł '{mod_id}' ma taki sam tytuł i kategorię jak istniejący wpis ('{entry['title']}').")
            ans = ask_user("Czy mimo to dodać ten moduł? (t/n)", "n", args.non_interactive)
            if ans.lower() not in ("t", "tak", "y", "yes"):
                skipped_modules.append((mod_id, "duplikat tytułu"))
                continue

        existing_packs.append(entry)
        existing_by_id[mod_key] = len(existing_packs) - 1
        existing_title_cats.add(title_cat_key)
        added_packs.append(entry)
        print(f"[DODANO] {entry['moduleId']} ('{entry['title']}', scen: {entry['sceneCount']}, cover: {entry['cover']})")

    print("\n=== Podsumowanie skanowania ===")
    print(f" * Łącznie paczek w katalogu:    {len(existing_packs)}")
    print(f" * Nowo wykryte i dodane:        {len(added_packs)}")
    print(f" * Zaktualizowane istniejące:    {len(updated_packs)}")
    print(f" * Usunięte martwe wpisy:        {pruned_count}")
    print(f" * Naprawione okładki (cover):   {fixed_covers_count}")
    print(f" * Pominięte foldery:            {len(skipped_modules)}")
    for m_id, reason in skipped_modules:
        print(f"   - {m_id}: {reason}")

    if not added_packs and not updated_packs and pruned_count == 0 and fixed_covers_count == 0:
        print("[INFO] Brak zmian do zapisania w catalog.json.")
        return

    existing_packs.sort(key=lambda p: (p.get("moduleId") or "").lower())
    catalog["packs"] = existing_packs
    catalog["totalPacks"] = len(existing_packs)

    try:
        serialized = json.dumps(catalog, ensure_ascii=False, indent=2)
        json.loads(serialized)
    except Exception as e:
        print(f"[BŁĄD KRYTYCZNY] Wynikowy JSON nie przeszedł walidacji składniowej: {e}. Przerywam bez zmian!")
        sys.exit(1)

    if args.dry_run:
        print("[DRY-RUN] Walidacja JSON pomyślna. Plik catalog.json nie został zmodyfikowany.")
        return

    if catalog_path.is_file():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = root_dir / f"catalog.json.bak.{timestamp}"
        shutil.copy2(catalog_path, backup_path)
        print(f"[BACKUP] Utworzono kopię zapasową: {backup_path.name}")

    tmp_catalog = root_dir / f"catalog.json.tmp.{os.getpid()}"
    try:
        tmp_catalog.write_text(serialized, encoding="utf-8")
        json.loads(tmp_catalog.read_text(encoding="utf-8"))
        os.replace(tmp_catalog, catalog_path)
        print(f"[SUKCES] Zaktualizowano plik {catalog_path} (łącznie paczek: {catalog['totalPacks']}).")
    except Exception as e:
        print(f"[BŁĄD KRYTYCZNY] Nie udało się zapisać catalog.json: {e}")
        if tmp_catalog.exists():
            tmp_catalog.unlink(missing_ok=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
