# Zychu's Map Browser (Foundry VTT)

A Foundry VTT module that lists map packs from a remote server and imports them into the active world. It adds a Map Browser button to the Scenes directory where the GM can search packs, filter them, and import them as scenes.

On import, the module downloads the map assets and saves them in the world's directory (`worlds/<worldId>/zychu-maps/`). The imported scenes use these local files, so they keep working if the remote server goes offline.

## Contents

- [Installation](#installation)
- [Usage](#usage)
- [Remote server setup](#remote-server-setup)
  - [Folder structure](#folder-structure)
  - [catalog.json format](#catalogjson-format)
  - [scenes.json format](#scenesjson-format)
  - [CORS configuration](#cors-configuration)
  - [Maintenance scripts](#maintenance-scripts)
- [Development notes](#development-notes)

## Installation

Paste this link into **Add-on Modules > Install Module > Manifest URL**:

```
https://github.com/zychuk/foundry-map-browser/releases/latest/download/module.json
```

## Usage

1. Enable the module in **Manage Modules**.
2. Go to **Configure Settings > Module Settings > Zychu's Map Browser** and enter the **Map Server URL** (for example, `https://maps.yourdomain.com`).
3. Open the **Scenes** directory in the right sidebar and click **Map Browser** at the top.
4. Search by name, or filter by category and by status (**All**, **Imported**, **Not Imported**).
5. Click **Import** on a pack to download all its scenes into a folder named `Zychu Maps / <Pack Name>`. Click **Scenes** to preview a pack and import individual scenes.

Imported scenes are tagged with module flags. The status shown for each pack (Imported, Partial, Not Imported) updates when scenes are added to or deleted from the world.

## Remote server setup

To host your own map server, it needs to be reachable over HTTP or HTTPS and serve a `catalog.json` file and the map asset folders.

### Folder structure

The web server (Caddy, Nginx, Apache, etc.) should serve a root directory like this:

```text
/srv/foundry-maps/
├── catalog.json
└── modules/
    ├── example-pack-01/
    │   ├── scenes.json
    │   ├── _thumbs/
    │   │   ├── example-map-day.webp
    │   │   └── ...
    │   └── maps/
    │       ├── example-map-day.jpg
    │       └── ...
    └── example-pack-02/
        ├── scenes.json
        ├── _thumbs/
        └── maps/
```

### catalog.json format

`catalog.json` in the root folder lists all packs. The module reads it to build the browser grid, so it does not need to download the scene files until a pack is imported.

```json
{
  "totalPacks": 1,
  "packs": [
    {
      "moduleId": "example-pack-01",
      "title": "Example Pack One",
      "category": "map",
      "cover": "modules/example-pack-01/_thumbs/example-map-day.webp",
      "sceneCount": 12,
      "version": "1.0.3",
      "scenes": [
        {
          "id": "3BixDKblW492O8uW",
          "name": "Example Map",
          "width": 4620,
          "height": 2940,
          "thumb": "modules/example-pack-01/_thumbs/example-map-day.webp",
          "bg": "modules/example-pack-01/maps/example-map-day.jpg"
        }
      ]
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `category` | `"map"` for battlemaps, `"scene"` for environments and portraits. |
| `cover` | Thumbnail shown on the pack tile. If it is missing or returns a 404, the module uses the first thumbnail in `scenes`. |
| `sceneCount` | Optional. The module uses the length of the `scenes` array instead. |

### scenes.json format

Each module folder contains a `scenes.json` file with standard Foundry VTT Scene data objects. The module works with the data structures from v9 through v14.

```json
[
  {
    "_id": "3BixDKblW492O8uW",
    "name": "Example Map",
    "width": 4620,
    "height": 2940,
    "grid": { "size": 140, "type": 1, "distance": 5, "units": "ft" },
    "background": {
      "src": "modules/example-pack-01/maps/example-map-day.jpg"
    },
    "walls": [],
    "tiles": []
  }
]
```

### CORS configuration

The server must send CORS headers so Foundry can fetch the image files during import.

Example for Caddy:

```caddyfile
maps.yourdomain.com {
    root * /srv/foundry-maps
    header {
        Access-Control-Allow-Origin "*"
        Access-Control-Allow-Methods "GET, HEAD, OPTIONS"
        Access-Control-Allow-Headers "*"
        Cross-Origin-Resource-Policy "cross-origin"
        Cache-Control "public, max-age=604800, immutable"
    }
    file_server
}
```

### Maintenance scripts

Two Python 3 scripts are included for maintaining the remote catalog.

`normalize_module.py` works on a copy of a raw folder or an old Foundry module. It generates `.webp` thumbnails (needs `cwebp`, `ffmpeg`, or Pillow), checks that the background files exist, and writes a clean `scenes.json`.

```bash
python3 normalize_module.py --input /path/to/raw-pack --dry-run
python3 normalize_module.py --input /path/to/raw-pack
```

`update_catalog.py` scans the `modules/` folder, adds new packs, makes a timestamped backup of `catalog.json`, fixes missing cover paths, checks the JSON syntax, and writes the file atomically.

```bash
python3 update_catalog.py --fix-missing-covers --dry-run
python3 update_catalog.py --fix-missing-covers
```

## Development notes

- **Local storage:** Imported maps, tokens, tiles, and thumbnails are stored in `worlds/<worldId>/zychu-maps/<moduleId>/`. Deleting a world also removes this folder.
- **Localization:** UI strings are in `lang/pl.json` and `lang/en.json`. New UI text should use `game.i18n.localize("ZMB.Key")`.
- **Foundry v14:** The module migrates `scene.levels` data so background images are assigned to the Initial Level.
