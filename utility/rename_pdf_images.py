#!/usr/bin/env python3
"""
Masowo analizuje obrazy z PDF-ów za pomocą lokalnego modelu wizyjnego qwen2.5vl:7b (Ollama /api/chat).
Łączy odpowiedź modelu z ekstrakcją konkretnych cech wizualnych bezpośrednio ze zdania obserwacji,
blokując ogólnikowe słowa typu 'creature', 'monster', 'character'.
"""

import argparse
import base64
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
except ImportError:
    print("[BŁĄD] Zainstaluj Pillow: sudo pacman -S python-pillow")
    sys.exit(1)

MODEL = "qwen2.5vl:7b"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".avif"}

TECHNICAL_NAME_REGEX = re.compile(
    r"^(p\d+_|page[_\-]?\d+|img[_\-]?\d+|image[_\-]?\d+|.*xref\d+|^\d+$)",
    re.IGNORECASE,
)

# Leniwe słowa-wypełniacze, których NIE chcemy w ostatecznej nazwie pliku
BANNED_NAME_WORDS = {
    "creature", "creatures", "monster", "monsters", "beast", "beasts",
    "character", "characters", "figure", "figures", "person", "people",
    "man", "woman", "guy", "girl", "electrician", "object", "thing",
    "png", "jpg", "webp", "image", "picture", "illustration", "book", "rpg",
    "background", "isolated", "drawing", "sketch", "art", "artwork", "plain",
    "concept", "standing", "looking", "posing", "view", "showing", "depicting",
    "fantastical", "fantasy", "monstrous", "menacing", "fierce", "chaotic",
    "scene", "detailed",
}

# Słowa gramatyczne i ogólniki pomijane przy dobieraniu konkretnych cech z 'observation'
OBS_STOPWORDS = BANNED_NAME_WORDS | {
    "a", "an", "the", "of", "in", "on", "at", "with", "without", "by", "from",
    "to", "into", "under", "over", "around", "between", "against", "is", "are",
    "was", "were", "be", "being", "been", "has", "have", "had", "having",
    "stands", "sitting", "floating", "emerging", "climbing", "surrounded",
    "pulled", "attacked", "faces", "confronts", "wields", "wearing", "resembling",
    "depicted", "shown", "set", "close", "up", "closeup", "large", "small",
    "long", "sharp", "thick", "textured", "various", "multiple", "several",
    "single", "upper", "lower", "body", "head", "hands", "limbs", "appendages",
    "features", "elements", "parts", "appearance", "expression", "style",
    "effects", "like", "its", "their", "his", "her", "it", "that", "this",
    "which", "who", "and", "or", "but", "as", "for",
}

PROMPT = (
    "Look carefully at this RPG illustration.\n"
    "Respond in JSON with two fields:\n"
    "1. \"observation\": A literal 1-sentence description of what is visibly present in the image "
    "(colors, anatomy, weapons, armor, wings, horns, tentacles, beak, environment).\n"
    "2. \"name\": A specific 3 to 4 word lowercase filename built ONLY from the most distinctive visual nouns and adjectives in your observation.\n\n"
    "STRICT RULES FOR \"name\":\n"
    "- MUST be 3 or 4 words.\n"
    "- NEVER use generic words like 'creature', 'monster', 'beast', 'character', 'figure', 'person', 'fantasy', 'electrician'.\n"
    "- Instead of 'creature', use the specific anatomy/shape or feature from your observation (e.g. 'spiky mane spotted quadruped', "
    "'armored curved beak insect', 'crowned skeletal lich', 'one eyed tentacle brain', 'tree dryad purple butterflies', "
    "'blue wraith pulling mage', 'electric blue armored warrior', 'twisted skull tree moon')."
)


def is_technical_filename(stem: str) -> bool:
    return bool(TECHNICAL_NAME_REGEX.search(stem.strip()))


def image_to_base64_thumb(img_path: Path, max_size: int = 768) -> str | None:
    try:
        with Image.open(img_path) as im:
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
            if im.mode == "RGBA":
                bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
                im = Image.alpha_composite(bg, im).convert("RGB")
            im.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=86)
            return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as e:
        print(f" [!] Nie udało się odczytać obrazu {img_path.name}: {e}")
        return None


def tokenize_clean(text: str) -> list[str]:
    text = (text or "").lower()
    text = re.sub(r"\b(on|with)?\s*(white|black|transparent|plain)\s+background\b", "", text)
    text = re.sub(r"([a-z0-9]+)-like\b", r"\1", text)
    text = re.sub(r"[^a-z0-9\s]+", " ", text)
    return [w for w in text.split() if len(w) > 1]


def build_rich_name(raw_name: str, observation: str) -> str:
    """
    Czyści proponowaną nazwę z leniwych słów ('creature', 'monster', 'character'),
    a jeśli po oczyszczeniu zostało mniej niż 3 konkretne słowa, automatycznie
    dopełnia nazwę najbardziej charakterystycznymi rzeczownikami/przymiotnikami ze zdania 'observation'.
    """
    words = []
    for w in tokenize_clean(raw_name):
        if w in BANNED_NAME_WORDS or w in ("a", "an", "the", "of", "and", "with", "in", "on"):
            continue
        if w not in words:
            words.append(w)

    if len(words) < 3 and observation:
        obs_tokens = tokenize_clean(observation)
        for ow in obs_tokens:
            if ow in OBS_STOPWORDS:
                continue
            if ow not in words:
                words.append(ow)
            if len(words) >= 4:
                break

    words = words[:4]
    return " ".join(words) or "rpg illustration"


def describe_image_with_ollama(img_path: Path, ollama_url: str) -> tuple[str, str]:
    b64_img = image_to_base64_thumb(img_path)
    if not b64_img:
        return "", ""

    payload = json.dumps({
        "model": MODEL,
        "messages": [
            {
                "role": "user",
                "content": PROMPT,
                "images": [b64_img],
            }
        ],
        "format": {
            "type": "object",
            "properties": {
                "observation": {"type": "string"},
                "name": {"type": "string"},
            },
            "required": ["observation", "name"],
        },
        "stream": False,
        "options": {
            "temperature": 0.1,
            "num_predict": 90,
        }
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{ollama_url.rstrip('/')}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            content = (data.get("message") or {}).get("content", "")
            parsed = json.loads(content)
            obs = (parsed.get("observation") or "").strip()
            raw_name = (parsed.get("name") or "").strip()
            final_name = build_rich_name(raw_name, obs)
            return final_name, obs
    except Exception as e:
        print(f" [!] Błąd komunikacji z Ollama ({ollama_url}): {e}")
        return "", ""


def process_folder(folder: Path, args):
    files = sorted([
        p for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not p.name.startswith(".")
    ])

    targets = [p for p in files if args.all or is_technical_filename(p.stem)]
    if not targets:
        return 0

    print(f"\n=== Folder: {folder} (model: {MODEL} | do nazwania: {len(targets)} / {len(files)} plików) ===")

    single_file_by_base: dict[str, Path] = {}
    counter_by_base: dict[str, int] = {}

    for existing in files:
        if existing in targets:
            continue
        stem_lower = existing.stem.lower()
        m = re.match(r"^(.*?)\s+(\d+)$", stem_lower)
        if m:
            base, num = m.group(1).strip(), int(m.group(2))
            counter_by_base[base] = max(counter_by_base.get(base, 1), num)
        else:
            single_file_by_base[stem_lower] = existing
            counter_by_base.setdefault(stem_lower, 1)

    renamed_count = 0
    for idx, img_path in enumerate(targets, 1):
        desc, obs = describe_image_with_ollama(img_path, args.ollama_url)
        if not desc:
            continue

        ext = img_path.suffix.lower()
        base_key = desc.lower()

        if base_key not in counter_by_base:
            counter_by_base[base_key] = 1
            dest_path = folder / f"{desc}{ext}"
            while dest_path.exists() and dest_path != img_path:
                counter_by_base[base_key] += 1
                dest_path = folder / f"{desc} {counter_by_base[base_key]}{ext}"

            if not args.dry_run and dest_path != img_path:
                img_path.rename(dest_path)
                single_file_by_base[base_key] = dest_path
            print(f" [{idx}/{len(targets)}] {img_path.name}  -->  {dest_path.name}   ({obs})")
            renamed_count += 1
        else:
            if base_key in single_file_by_base:
                first_file = single_file_by_base.pop(base_key)
                if first_file.exists():
                    first_numbered = first_file.with_name(f"{first_file.stem} 1{first_file.suffix.lower()}")
                    if not first_numbered.exists() and not args.dry_run:
                        first_file.rename(first_numbered)
                        print(f"       (zmieniono pierwszy duplikat: {first_file.name} --> {first_numbered.name})")

            next_num = counter_by_base[base_key] + 1
            dest_path = folder / f"{desc} {next_num}{ext}"
            while dest_path.exists() and dest_path != img_path:
                next_num += 1
                dest_path = folder / f"{desc} {next_num}{ext}"
            counter_by_base[base_key] = next_num

            if not args.dry_run and dest_path != img_path:
                img_path.rename(dest_path)
            print(f" [{idx}/{len(targets)}] {img_path.name}  -->  {dest_path.name}   ({obs})")
            renamed_count += 1

    return renamed_count


def main():
    parser = argparse.ArgumentParser(description=f"Nazywa obrazy z PDF-ów za pomocą modelu {MODEL} (Ollama).")
    parser.add_argument("--input", "-i", required=True, help="Ścieżka do folderu z obrazami (skanuje też podfoldery).")
    parser.add_argument("--ollama-url", default="http://127.0.0.1:11434", help="Adres lokalnego serwera Ollama.")
    parser.add_argument("--all", action="store_true", help="Zmień nazwy wszystkich obrazów (również już wcześniej nazwanych).")
    parser.add_argument("--dry-run", action="store_true", help="Tylko pokaż proponowane nazwy bez zmiany plików na dysku.")
    args = parser.parse_args()

    root_dir = Path(args.input).expanduser().resolve()
    if not root_dir.is_dir():
        print(f"[BŁĄD] Katalog nie istnieje: {root_dir}")
        sys.exit(1)

    all_folders = sorted({
        p.parent for p in root_dir.rglob("*")
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS and "_thumbs" not in p.parts
    })

    total_renamed = 0
    for folder in all_folders:
        total_renamed += process_folder(folder, args)

    mode = "[DRY-RUN]" if args.dry_run else "[GOTOWE]"
    print(f"\n{mode} Przemianowano łącznie: {total_renamed} plików.")


if __name__ == "__main__":
    main()
