"""Frame effect `brightness`: same PIL operation as the image tool Tools/brightness."""
from PIL import Image, ImageEnhance


def apply(img: Image.Image, brightness: float) -> Image.Image:
    return ImageEnhance.Brightness(img).enhance(float(brightness))
