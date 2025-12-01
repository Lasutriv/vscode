# Brand Icon Generator

A cross-platform tool to generate all required icon sizes and formats for VS Code (or any Electron app) from a single source PNG image.

## Features

- **Windows**: Generates `.ico` file (multi-resolution), tile PNGs (70x70, 150x150), and Inno Setup installer BMPs
- **macOS**: Generates `.icns` file and `.iconset` folder with all required sizes including @2x Retina variants
- **Linux**: Generates all standard PNG sizes (16, 24, 32, 48, 64, 128, 256, 512, 1024)

## Requirements

- Node.js 16+
- Source PNG image (ideally 1024x1024 or larger)

## Installation

```bash
cd scripts/brand-icons
npm install
```

## Usage

### Using npm scripts

```bash
# Generate icons from Summit-Tec logo
npm run generate:summit
```

### Custom source image

```bash
node generate.js <source-png> <output-dir> <app-name>

# Example:
node generate.js ../../resources/MyBrand.png ../../resources myapp
```

### Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `source-png` | Path to source PNG file (1024x1024 recommended) | `../../resources/Summit-Tec-Clean.png` |
| `output-dir` | Directory to output generated icons | `../../resources` |
| `app-name` | Base name for generated files (e.g., "code" → "code.ico") | `code` |

## Generated Assets

### Windows (`win32/`)

| File | Description |
|------|-------------|
| `{app-name}.ico` | Multi-resolution ICO (16, 24, 32, 48, 64, 128, 256) |
| `{app-name}_70x70.png` | Small Start menu tile |
| `{app-name}_150x150.png` | Large Start menu tile |
| `inno-big-{dpi}.bmp` | Installer sidebar images (100-250 DPI) |
| `inno-small-{dpi}.bmp` | Installer header images (100-250 DPI) |

### macOS (`darwin/`)

| File | Description |
|------|-------------|
| `{app-name}.icns` | macOS icon file |
| `{app-name}.iconset/` | Iconset folder with all sizes |

### Linux (`linux/`)

| File | Description |
|------|-------------|
| `{app-name}.png` | Main icon (1024x1024) |
| `{app-name}_{size}x{size}.png` | Individual sizes (16-1024) |

## Source Image Requirements

For best results:

1. **Size**: 1024x1024 pixels minimum
2. **Format**: PNG with transparency (RGBA)
3. **Design**: Keep important elements centered and avoid fine details that may be lost at small sizes
4. **Safe area**: Leave ~10% padding around edges for platform variations

## Customizing Installer Background Color

Edit `generate.js` and change the `bgColor` parameter in `generateInnoBmps()`:

```javascript
// Default is dark gray (#1e1e1e)
await generateInnoBmps(sourceImage, outputDir, 0x1e1e1eff);

// Change to your brand color (format: 0xRRGGBBAA)
await generateInnoBmps(sourceImage, outputDir, 0x007accff); // VS Code blue
```

## Dependencies

- **jimp**: Pure JavaScript image processing
- **png-to-ico**: Windows ICO generation
- **png2icons**: macOS ICNS generation

## Troubleshooting

### ICO generation fails

Ensure `png-to-ico` is installed:
```bash
npm install png-to-ico
```

### ICNS generation fails

Ensure `png2icons` is installed:
```bash
npm install png2icons
```

Alternatively, on macOS you can use the native `iconutil`:
```bash
iconutil -c icns resources/darwin/code.iconset -o resources/darwin/code.icns
```

### Image quality issues at small sizes

Consider creating a simplified version of your logo for sizes below 32x32 pixels. Complex logos may need manual adjustment for icon sizes.
