"""Backend for ImageLoaderPlus. Files are always restricted to ComfyUI/input."""

from __future__ import annotations

import asyncio
from functools import lru_cache
import io
import os
from pathlib import Path
import re
import shutil
import sys
from datetime import datetime
from uuid import uuid4

import folder_paths
import numpy as np
from PIL import Image, ImageOps
import torch

ALLOWED_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
MAX_LIST = 5000
MAX_THUMB = 640
MAX_BATCH = 200
_HIDDEN_DIRS = {".imageloaderplus-trash"}


def _root() -> Path:
    return Path(folder_paths.get_input_directory()).resolve()


def _resolve_image(relative: str, require_file: bool = True) -> Path:
    """Never allow absolute paths, path traversal, or symlink escapes."""
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError("No image selected. Use the gallery, Paste, or Drop.")
    value = relative.replace("\\", "/")
    if value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise ValueError("Only images inside ComfyUI/input are allowed.")
    if any(part in ("..", "") for part in value.split("/")):
        raise ValueError("Invalid image path.")
    root = _root()
    candidate = (root / value).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("Image path is outside ComfyUI/input.") from exc
    if candidate.suffix.lower() not in ALLOWED_EXTS:
        raise ValueError("Unsupported image format.")
    if require_file and not candidate.is_file():
        raise ValueError("Image not found in ComfyUI/input.")
    return candidate


def _relpath(path: Path) -> str:
    return path.relative_to(_root()).as_posix()


def _enumerate_gallery() -> tuple[list[dict], list[str], bool]:
    """List supported images plus *empty* folders; never follow symlinks."""
    root = _root()
    files = []
    found_folders = set()
    truncated = False
    for base, folders, filenames in os.walk(root, followlinks=False):
        valid = []
        for name in folders:
            sub = Path(base) / name
            if name.casefold() in _HIDDEN_DIRS or sub.is_symlink():
                continue
            try:
                sub.resolve().relative_to(root)
            except (OSError, ValueError):
                continue
            if sub.is_dir():
                valid.append(name)
                found_folders.add(sub.relative_to(root).as_posix())
        folders[:] = valid
        for filename in filenames:
            candidate = Path(base) / filename
            if candidate.suffix.lower() not in ALLOWED_EXTS or candidate.is_symlink():
                continue
            try:
                candidate.resolve().relative_to(root)
                stat = candidate.stat()
            except (OSError, ValueError):
                continue
            if not candidate.is_file():
                continue
            files.append({
                "path": candidate.relative_to(root).as_posix(),
                "name": filename,
                "mtime": int(stat.st_mtime_ns),
                "size": stat.st_size,
            })
            if len(files) >= MAX_LIST:
                truncated = True
                break
        if truncated:
            # Keep folder listing available even when image limit is hit.
            break
    files.sort(key=lambda x: x["path"].casefold())
    return files, sorted(found_folders, key=str.casefold), truncated


def _enumerate_images() -> tuple[list[dict], bool]:
    """Compatibility wrapper used by existing tests/code."""
    files, _, truncated = _enumerate_gallery()
    return files, truncated


def _parts(relative: str, allow_root: bool = False) -> list[str]:
    if not isinstance(relative, str):
        raise ValueError("Invalid path.")
    if not relative and allow_root:
        return []
    value = relative.replace("\\", "/")
    if not value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise ValueError("Only paths inside ComfyUI/input are allowed.")
    parts = value.split("/")
    if any(part in ("", ".", "..") or "\x00" in part for part in parts):
        raise ValueError("Invalid path.")
    if any(part.casefold() in _HIDDEN_DIRS for part in parts):
        raise ValueError("This folder is not managed by ImageLoaderPlus.")
    return parts


def _no_symlink_parts(parts: list[str]):
    """Reject links even if their targets happen to remain inside input."""
    current = _root()
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symbolic links are not allowed for file management.")
    return current


def _resolve_managed_image(relative: str) -> Path:
    parts = _parts(relative)
    path = _no_symlink_parts(parts)
    if path.suffix.lower() not in ALLOWED_EXTS or not path.is_file():
        raise ValueError("Image not found in ComfyUI/input.")
    path.resolve().relative_to(_root())
    return path


def _resolve_folder(relative: str) -> Path:
    parts = _parts(relative, allow_root=True)
    path = _no_symlink_parts(parts)
    if not path.is_dir():
        raise ValueError("Folder does not exist inside ComfyUI/input.")
    path.resolve().relative_to(_root())
    return path


def _create_folder(parent: str, name: str) -> str:
    base = _resolve_folder(parent)
    if not isinstance(name, str):
        raise ValueError("Folder name is required.")
    name = name.strip()
    if (not name or len(name) > 128 or name in (".", "..")
        or name.casefold() in _HIDDEN_DIRS
        or name[-1] in " ." or re.search(r'[<>:"/\\|?*\x00-\x1f]', name)
        or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", name)):
        raise ValueError("Invalid folder name.")
    destination = base / name
    if destination.exists() or destination.is_symlink():
        raise ValueError("A folder or file with this name already exists.")
    destination.mkdir()
    return destination.relative_to(_root()).as_posix()


def _checked_batch(paths: list[str]) -> list[tuple[str, Path]]:
    if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_BATCH:
        raise ValueError(f"Choose 1 to {MAX_BATCH} images.")
    if not all(isinstance(path, str) for path in paths) or len(set(paths)) != len(paths):
        raise ValueError("Invalid or duplicate image paths.")
    # Validate the *whole* batch before changing anything.
    return [(relative, _resolve_managed_image(relative)) for relative in paths]


def _move_images(paths: list[str], destination_folder: str) -> list[dict]:
    sources = _checked_batch(paths)
    folder = _resolve_folder(destination_folder)
    moved = []
    for relative, source in sources:
        if source.parent == folder:
            moved.append({"from": relative, "to": relative})
            continue
        target = folder / source.name
        if target.exists() or target.is_symlink():
            stem, ext = source.stem, source.suffix
            for i in range(1, 10001):
                target = folder / f"{stem}_{i}{ext}"
                if not target.exists() and not target.is_symlink():
                    break
            else:
                raise ValueError("Unable to find a free destination filename.")
        # Avoid silently replacing other image files.
        source.rename(target)
        moved.append({"from": relative, "to": target.relative_to(_root()).as_posix()})
    _thumbnail_bytes.cache_clear()
    return moved


def _send_to_recycle_bin(path: Path):
    """No permanent deletion: prefer send2trash, fall back to native Windows shell."""
    try:
        from send2trash import send2trash
    except ImportError:
        send2trash = None
    if send2trash is not None:
        send2trash(str(path))
        return
    if sys.platform != "win32":
        raise RuntimeError("Safe deletion needs send2trash: pip install send2trash")
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR), ("pTo", wintypes.LPCWSTR),
            ("fFlags", wintypes.WORD), ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", wintypes.LPVOID), ("lpszProgressTitle", wintypes.LPCWSTR),
        ]
    # FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FOF_NOERRORUI
    operation = SHFILEOPSTRUCTW()
    operation.wFunc = 3
    operation.pFrom = str(path) + "\0\0"
    operation.fFlags = 0x40 | 0x10 | 0x4 | 0x400
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(operation))
    if rc != 0 or operation.fAnyOperationsAborted:
        raise RuntimeError(f"Could not move image to Windows Recycle Bin (code {rc}).")


def _recycle_images(paths: list[str]) -> list[str]:
    sources = _checked_batch(paths)
    deleted = []
    for relative, source in sources:
        _send_to_recycle_bin(source)
        deleted.append(relative)
    _thumbnail_bytes.cache_clear()
    return deleted


@lru_cache(maxsize=384)
def _thumbnail_bytes(path_str: str, mtime_ns: int, width: int, height: int) -> bytes:
    # The cache is keyed by modification time and size; failures aren't cached.
    path = _resolve_image(path_str)
    with Image.open(path) as source:
        if getattr(source, "n_frames", 1) > 1:
            source.seek(0)
        frame = ImageOps.exif_transpose(source)
        frame.thumbnail((width, height), Image.Resampling.LANCZOS)
        if frame.mode not in ("RGB", "RGBA"):
            frame = frame.convert("RGBA" if "A" in frame.getbands() else "RGB")
        with io.BytesIO() as buffer:
            frame.save(buffer, format="WEBP", quality=78, method=2)
            return buffer.getvalue()


def _unique_destination(filename: str) -> Path:
    root = _root()
    filename = Path(filename).name
    stem = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", "_", Path(filename).stem).strip(" .")[:90] or "image"
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTS:
        ext = ".png"
    for number in range(10000):
        suffix = f"_{number}" if number else ""
        dst = root / f"{stem}{suffix}{ext}"
        if not dst.exists():
            return dst
    return root / f"{stem}_{uuid4().hex[:8]}{ext}"


def _save_windows_clipboard() -> str:
    """Windows-native fallback for Explorer Ctrl+C files and copied browser pixels.

    Only called from an explicit user action in the UI; never poll clipboard.
    """
    if sys.platform != "win32":
        raise RuntimeError("Native clipboard fallback is only available on Windows.")
    from PIL import ImageGrab

    data = ImageGrab.grabclipboard()
    root = _root()
    root.mkdir(parents=True, exist_ok=True)
    if isinstance(data, list):
        for name in data:
            path = Path(name)
            if path.is_file() and path.suffix.lower() in ALLOWED_EXTS:
                dest = _unique_destination(path.name)
                # A literal file copy preserves PNG info, EXIF and other metadata.
                shutil.copy2(path, dest)
                return _relpath(dest)
        raise ValueError("Clipboard does not contain a supported image file.")
    if isinstance(data, Image.Image):
        name = f"Pasted_{datetime.now():%Y%m%d_%H%M%S}_{uuid4().hex[:6]}.png"
        dest = _unique_destination(name)
        data.save(dest, format="PNG")
        return _relpath(dest)
    raise ValueError("No image found in Windows clipboard.")


class ImageLoaderPlus:
    """A Load Image replacement with a transient selection widget.

    Frontend marks the `image` widget nonpersistent in workflow JSON, but leaves
    its prompt serialization enabled so the selected image reaches Python.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("STRING", {"default": "", "multiline": False})}}

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "MASK")
    FUNCTION = "load_image"
    CATEGORY = "image/ImageLoaderPlus"
    DESCRIPTION = "Load an image from ComfyUI/input with a private list, gallery, paste and drop. Selection is not saved in workflows."

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        try:
            _resolve_image(image)
            return True
        except (ValueError, OSError) as exc:
            return str(exc)

    @classmethod
    def IS_CHANGED(cls, image):
        try:
            f = _resolve_image(image)
            stat = f.stat()
            return (image, stat.st_size, stat.st_mtime_ns)
        except (ValueError, OSError):
            return float("nan")

    def load_image(self, image):
        path = _resolve_image(image)
        with Image.open(path) as img:
            # First frame: simple, predictable single IMAGE output.
            img.seek(0)
            frame = ImageOps.exif_transpose(img)
            mask = None
            if "A" in frame.getbands():
                alpha = np.asarray(frame.getchannel("A"), dtype=np.float32) / 255.0
                mask = 1.0 - torch.from_numpy(alpha)
            rgb = np.asarray(frame.convert("RGB"), dtype=np.float32) / 255.0
        image_tensor = torch.from_numpy(rgb).unsqueeze(0)
        if mask is None:
            mask_tensor = torch.zeros((1, 64, 64), dtype=torch.float32)
        else:
            mask_tensor = mask.unsqueeze(0)
        return (image_tensor, mask_tensor)


_routes_registered = False


def register_routes():
    global _routes_registered
    if _routes_registered:
        return
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/imageloaderplus/list")
    async def get_gallery(request):
        try:
            files, folders, truncated = await asyncio.to_thread(_enumerate_gallery)
            return web.json_response({"files": files, "folders": folders, "truncated": truncated})
        except Exception as exc:
            return web.json_response({"error": f"Cannot list input: {exc}"}, status=500)

    @routes.get("/imageloaderplus/thumb")
    async def get_thumbnail(request):
        rel = request.query.get("path", "")
        try:
            path = _resolve_image(rel)
            stat = path.stat()
            w = min(MAX_THUMB, max(32, int(request.query.get("w", "140"))))
            h = min(MAX_THUMB, max(32, int(request.query.get("h", "125"))))
            payload = await asyncio.to_thread(_thumbnail_bytes, rel, stat.st_mtime_ns, w, h)
            return web.Response(body=payload, content_type="image/webp", headers={"Cache-Control": "private, max-age=60"})
        except (ValueError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Thumbnail failed: {exc}"}, status=500)

    @routes.post("/imageloaderplus/clipboard")
    async def paste_windows_clipboard(request):
        try:
            path = await asyncio.to_thread(_save_windows_clipboard)
            return web.json_response({"path": path})
        except (ValueError, RuntimeError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Clipboard failed: {exc}"}, status=500)

    async def parse_action(request):
        if request.content_type != "application/json":
            raise ValueError("Expected JSON request.")
        origin = request.headers.get("Origin")
        if origin:
            from urllib.parse import urlsplit
            try:
                source = urlsplit(origin)
                if source.netloc.lower() != request.host.lower() or source.scheme not in ("http", "https"):
                    raise ValueError("Cross-origin file changes are not allowed.")
            except (TypeError, ValueError) as exc:
                raise ValueError("Cross-origin file changes are not allowed.") from exc
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("Expected JSON object.")
        return data

    @routes.post("/imageloaderplus/mkdir")
    async def new_folder(request):
        try:
            data = await parse_action(request)
            path = await asyncio.to_thread(_create_folder, data.get("parent", ""), data.get("name", ""))
            return web.json_response({"folder": path})
        except (ValueError, OSError) as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post("/imageloaderplus/move")
    async def move_files(request):
        try:
            data = await parse_action(request)
            moved = await asyncio.to_thread(_move_images, data.get("paths"), data.get("folder", ""))
            return web.json_response({"moved": moved})
        except (ValueError, OSError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Moving failed: {exc}"}, status=500)

    @routes.post("/imageloaderplus/delete")
    async def delete_files(request):
        try:
            data = await parse_action(request)
            deleted = await asyncio.to_thread(_recycle_images, data.get("paths"))
            return web.json_response({"deleted": deleted})
        except (ValueError, OSError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": f"Recycle bin operation failed: {exc}"}, status=500)

    _routes_registered = True
