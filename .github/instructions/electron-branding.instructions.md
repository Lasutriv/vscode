---
applyTo: "**/resources/**"
description: Guidelines for Electron app icon branding and asset generation
---

# Electron App Icon Branding Guide

This guide covers how to replace default branding with custom icons in an Electron-based application like VS Code.

## Quick Start

Use the brand icon generator tool:

```bash
cd scripts/brand-icons
npm install
npm run generate:summit
```

Or with custom source:
```bash
node generate.js <source-png> <output-dir> <app-name>
```

---

## Platform-Specific Requirements

### 1. Windows Executable Icon (Taskbar/File Explorer)

**File:** `resources/win32/{app_name}.ico`

This icon appears in:
- The taskbar when the app is running
- File Explorer when viewing the .exe file
- Alt+Tab window switching
- Start menu shortcuts

**ICO file requirements:**
- Must contain multiple resolutions: 16x16, 24x24, 32x32, 48x48, 64x64, 128x128, 256x256
- Generated automatically by the brand-icons tool

---

### 2. macOS App Icon

**File:** `resources/darwin/{app_name}.icns`

**ICNS file requirements:**
- Contains sizes: 16, 32, 64, 128, 256, 512, 1024 (with @2x variants)
- Generated automatically by the brand-icons tool

**Manual generation on macOS:**
```bash
iconutil -c icns resources/darwin/{app_name}.iconset -o resources/darwin/{app_name}.icns
```

---

### 3. Linux Icons

**Files:** `resources/linux/{app_name}.png` (various sizes)

| Size | File |
|------|------|
| 16x16 | `{app_name}_16x16.png` |
| 24x24 | `{app_name}_24x24.png` |
| 32x32 | `{app_name}_32x32.png` |
| 48x48 | `{app_name}_48x48.png` |
| 64x64 | `{app_name}_64x64.png` |
| 128x128 | `{app_name}_128x128.png` |
| 256x256 | `{app_name}_256x256.png` |
| 512x512 | `{app_name}_512x512.png` |
| 1024x1024 | `{app_name}_1024x1024.png` |

---

### 4. Windows Installer Images (Inno Setup)

**Files:** `resources/win32/inno-*.bmp`

| File Pattern | Purpose | Base Size |
|--------------|---------|-----------|
| `inno-big-{dpi}.bmp` | Installer sidebar (wizard left panel) | 164x314 @100% |
| `inno-small-{dpi}.bmp` | Installer header (top banner) | 55x55 @100% |

**DPI variants needed:** 100, 125, 150, 175, 200, 225, 250

**BMP requirements:**
- 24-bit color depth
- No alpha channel (use solid background)

---

### 5. Windows Tile Images (Start Menu)

| File | Size | Purpose |
|------|------|---------|
| `{app_name}_150x150.png` | 150x150 | Large Start menu tile |
| `{app_name}_70x70.png` | 70x70 | Small Start menu tile |

**Related:** `VisualElementsManifest.xml` defines tile colors and logo paths

---

## Complete Asset Checklist

```
resources/
├── win32/
│   ├── {app_name}.ico                    # Main Windows icon
│   ├── {app_name}_150x150.png            # Large tile
│   ├── {app_name}_70x70.png              # Small tile
│   ├── inno-big-100.bmp                  # Installer sidebar @100%
│   ├── inno-big-125.bmp                  # ... up to 250
│   ├── inno-small-100.bmp                # Installer header @100%
│   └── VisualElementsManifest.xml        # Tile configuration
├── darwin/
│   ├── {app_name}.icns                   # macOS icon
│   └── {app_name}.iconset/               # Source iconset folder
└── linux/
    ├── {app_name}.png                    # Main icon (1024x1024)
    └── {app_name}_{size}x{size}.png      # Sized variants
```

---

## Source Image Best Practices

1. **Size**: Start with at least 1024x1024 PNG
2. **Format**: PNG with transparency (RGBA)
3. **Safe area**: Keep important elements within center 80%
4. **Simplicity**: Complex logos may need simplified versions for small sizes

---

## Upstream Sync Conflicts (for forks)

When syncing from upstream, expect merge conflicts in:
- `resources/win32/{app_name}.ico`
- `resources/win32/*.bmp`
- `resources/darwin/{app_name}.icns`

**Resolution strategy:** Always keep your branded versions of these files.

## Learnings

(none yet)
