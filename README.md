# Zychu's Map Browser (Foundry VTT)

A central map and scene browser connecting directly to a remote self-hosted server (homelab, VPS, or CDN). Allows GMs to search, browse, and 1-click import hundreds of map packs into their world without installing or managing individual map modules.

Maps and scene assets stream directly from your remote web server via URL, keeping your Foundry `Data` directory and backups completely lightweight (0 MB local world disk storage).

## Installation

Paste the link below into **Add-on Modules → Install Module → Manifest URL**:

```
https://github.com/zychuk/foundry-map-browser/releases/latest/download/module.json
```

## Usage

- Enable the module in **Manage Modules**.
- Go to **Configure Settings → Module Settings → Homelab Map Browser** and enter your **Map Server URL** (e.g., `https://maps.yourdomain.com`).
- Open the **Scenes** directory in the right sidebar and click **Map Browser** at the top.
- Use the search bar and status filters (**All**, **Imported**, **Not Imported**) to find packs.
- Click **Import** on any pack to import all its scenes into a dedicated folder, or open **Scenes** to preview and import individual variants.

## Notes

- **CORS Required:** Your remote web server (Caddy, Nginx, Apache) must return the `Access-Control-Allow-Origin "*"` header so Foundry's WebGL canvas can load textures across domains.
- **Remote Streaming:** Imported scenes automatically rewrite all background images, overhead roof tiles, and media paths to remote URLs.
- **Import Tracking:** Imported scenes are tagged with module flags, updating status badges (**Imported** / **Partial** / **Not Imported**) in real-time as scenes are added or deleted from the world.
