# ImageLoaderPlus for ComfyUI

**ImageLoaderPlus** is a compact image loader with a floating input-gallery and file organizer for ComfyUI. It provides standard `IMAGE` and `MASK` outputs and manages images strictly inside the selected ComfyUI installation's `input` folder.

**Current version: v0.1.7.** This repository is a publication of the tested build, not a new major release.

## Features

- **Gallery or private list:** browse images through a resizable, draggable manager window. Switch between thumbnail grid (S/L) and a text-only list; the viewing mode is remembered in the browser.
- **Per-folder browsing:** select the root `input` directory or a subfolder. Each list and folder count includes only images directly inside that folder, not files in nested folders.
- **Search and folders:** search within the selected folder and create new nested folders.
- **File management:** multi-select, move, drag files onto destination folders, or send selected files to the operating system's Recycle Bin/Trash (with confirmation). Name collisions get numerical suffixes; moves never silently overwrite files.
- **Clipboard and drag-and-drop:** paste copied image pixels or Explorer image files, or drop an image onto the node; copied files go into `input`.
- **Four compact node controls:** Paste, Clear, Show/Hide Preview, Open Gallery. Previews fit inside the existing node size.
- **Temporary selection:** the chosen file path is **not persisted in saved workflows**. Reopening a workflow requires selecting an image again. This does not delete or move any images on disk.

Supports PNG, JPEG, WebP, BMP, GIF and TIFF (first frame for animated images).

## Installation

Close ComfyUI, then choose one method:

### Git clone

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/dar06051990-oss/ComfyUI-ImageLoaderPlus.git
```

### ZIP

Download the repository ZIP, extract it into `ComfyUI/custom_nodes/ComfyUI-ImageLoaderPlus`, and ensure `__init__.py` is directly inside that folder (not inside an extra nested directory).

Restart ComfyUI and refresh the browser (Ctrl+F5). Add **ImageLoaderPlus** from **image / ImageLoaderPlus**.

**Dependencies:** the node uses `torch`, `numpy`, `Pillow`, and `aiohttp` supplied by a standard ComfyUI installation; no extra packages are required for its normal features. Safe deletion uses `send2trash` if available; on Windows it falls back to the native Windows Recycle Bin API. On Linux/macOS, install `send2trash` in the selected ComfyUI Python environment to enable safe deletion.

## Usage

1. Add the `ImageLoaderPlus` node and connect `IMAGE` and/or `MASK` to the rest of your workflow.
2. Click the folder button to browse `ComfyUI/input`, or paste/drop an image.
3. Click a file to select it; the window closes automatically in ordinary selection mode.
4. Use the square-check button to enter multi-select management mode. Move or recycle images from there. Right-click a file for a shortcut to management mode.

## Safety and limitations

- Paths are restricted to `ComfyUI/input`; file-management operations reject absolute paths, directory traversal and symbolic links.
- Moving or recycling an image can break existing workflows that still refer to its old file path. Saved workflows are not automatically rewritten.
- Up to 200 images can be changed in a single operation; the gallery lists up to 5,000 images.
- For shared or remotely accessible ComfyUI instances, understand that the node adds HTTP routes for file management and clipboard access. Use the same access controls you normally apply to ComfyUI.
- Test move/recycle operations with a disposable image first. On filesystems without Trash/Recycle Bin support, deletion may fail safely.

## Version history

See [CHANGELOG.md](CHANGELOG.md) for changes in v0.1.5–v0.1.7. The original Russian release notes are preserved in [README.ru.md](README.ru.md).

## License

[MIT License](LICENSE), copyright © 2026 `dar06051990-oss`.
