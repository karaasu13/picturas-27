"""Per-frame effects of the video edit service.

Every module of this package is one effect: its file name is the procedure
name and its `apply(img, **params)` function mirrors exactly the PIL operation
of the matching image microservice (Tools/<tool>/<tool>.py), so the same
effect gives the same result on an image and on every frame of a video.
Parameter names are the ones the frontend already sends to the image tools.

To add a frame effect, add a module here. Nothing else in this service changes.
"""
import importlib
import pkgutil

from PIL import Image

from common.errors import UnsupportedEffect

# Effects applied frame by frame: {procedure: apply function}
FRAME_EFFECTS = {
    module.name: importlib.import_module(f"{__name__}.{module.name}").apply
    for module in pkgutil.iter_modules(__path__)
}


def frame_effect(name: str):
    effect = FRAME_EFFECTS.get(name)
    if effect is None:
        raise UnsupportedEffect(f"Effect '{name}' is not available for video")
    return effect


def apply_frame_effects(img: Image.Image, tools: list) -> Image.Image:
    """Applies the frame effects in `tools`, in the given order."""
    for tool in tools:
        img = frame_effect(tool["procedure"])(img, **(tool.get("params") or {}))
        if img.mode != "RGB":
            img = img.convert("RGB")
    return img
