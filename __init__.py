"""ImageLoaderPlus: a privacy-aware image input gallery for ComfyUI."""

from .image_loader_plus import ImageLoaderPlus, register_routes

NODE_CLASS_MAPPINGS = {"ImageLoaderPlus": ImageLoaderPlus}
NODE_DISPLAY_NAME_MAPPINGS = {"ImageLoaderPlus": "ImageLoaderPlus"}
WEB_DIRECTORY = "./web"

register_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
