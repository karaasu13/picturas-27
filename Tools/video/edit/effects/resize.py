"""Frame effect `resize`: same PIL operation as the image tool Tools/resize."""
from PIL import Image


def apply(img: Image.Image, width: int, height: int) -> Image.Image:
    return img.resize((int(width), int(height)))
